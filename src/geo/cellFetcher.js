/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Cell fetcher — the server-side primitive that powers the GeoView cell-cache
 * architecture.
 *
 * `getDocsInCell` returns either the raw docs in a cell (when the count is
 * small) or a pre-aggregated cluster (when it isn't). The client cache
 * holds whichever the server returned per cell. GeoView renders raw docs as
 * singletons and clusters as gradient circles — no mode switch in the
 * component, just a per-feature shape check.
 *
 * Pure server logic. No HTTP, no Meteor. The caller passes an `ontologize`
 * instance whose `.collections` map resolves a string name to a Mongo-driver
 * shaped Collection (same shape OntologizeServer uses throughout — see
 * Ontologize.js / OntologizeServer.js).
 */

import * as h3 from "h3-js";
import { h3FieldName } from "./h3.js";

/** Top-N group breakdown limit when groupProperty is provided. */
const TOP_GROUPS_LIMIT = 10;

/**
 * Number of time buckets per groupClusters entry (geo-view-spec.md §5.4).
 * Each bucket covers (endMs - startMs) / N of the per-group timeRange and
 * holds the count of docs in that sub-interval. Powers TimePathPlugin's
 * bucket-aware "isActive" check, which fixes §18.7 #7's "before-and-after
 * but not during" gap.
 */
const CLUSTER_BUCKET_COUNT = 16;

/**
 * Bin a list of doc timestamps into N equal sub-intervals of [minMs, maxMs],
 * recording the actual min/max doc time within each bucket. Used by the
 * client (TimePathPlugin) to answer "was the animal actually present at
 * currentTime?" — a bucket's window is fixed, but its `{minMs, maxMs}` says
 * where inside the window the docs really sit, catching gaps that the
 * §18.10-initial "non-zero count" check missed for densely-visited cells.
 *
 *   - N = CLUSTER_BUCKET_COUNT (16). bucket i covers [minMs + i*bw, minMs + (i+1)*bw).
 *   - The final bucket (i = N - 1) is *inclusive* at maxMs so docs at the
 *     exact endpoint aren't dropped.
 *   - Each entry: `{ minMs, maxMs }` of the docs in that bucket, or `null`
 *     when the bucket is empty (animal had no docs in that sub-interval).
 *   - Zero-span (minMs === maxMs, single doc): return [{ minMs, maxMs }] of
 *     length 1. Client checks bucket length === 1 to special-case.
 *   - Empty / missing input: returns [].
 *
 * Residual limitation: multiple visits inside the same bucket collapse into
 * one `{minMs, maxMs}` span — a Mon-morning + Fri-afternoon pair in the same
 * bucket will test active on Wed-noon. Mitigated by finer buckets (raise
 * CLUSTER_BUCKET_COUNT) or moving to variable-length intervals; out of scope
 * for the current trial.
 */
function binTimes(times, minMs, maxMs) {
  if (!Array.isArray(times) || times.length === 0) return [];
  if (minMs == null || maxMs == null) return [];
  if (minMs === maxMs) return [{ minMs, maxMs }];
  const N = CLUSTER_BUCKET_COUNT;
  const bw = (maxMs - minMs) / N;
  const buckets = new Array(N).fill(null);
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t == null) continue;
    const idx = t >= maxMs
      ? N - 1
      : Math.min(N - 1, Math.max(0, Math.floor((t - minMs) / bw)));
    const b = buckets[idx];
    if (b === null) {
      buckets[idx] = { minMs: t, maxMs: t };
    }
    else {
      if (t < b.minMs) b.minMs = t;
      if (t > b.maxMs) b.maxMs = t;
    }
  }
  return buckets;
}

/**
 * Resolve a collection name via the ontologize instance's collections map.
 * The map is populated by the app at startup (see imports/startup/server/
 * index.js for a Critter Track example). Throws if the name is unknown so
 * caller / route-level validation catches bad input early.
 */
async function resolveCollection(ontologize, name) {
  const col = ontologize?.collections?.[name];
  if (!col) {
    const known = Object.keys(ontologize?.collections ?? {}).join(", ") || "(none)";
    throw new Error(`Unknown collection "${name}". Known: ${known}`);
  }
  // Windowed: this is the path that ships whole raw documents to the browser.
  // `publicCollection` returns the collection untouched unless it is configured
  // for windowing, so hosts that set no policy are unaffected. Kept in lockstep
  // with the app-side twin in /server/lib/geoCellFetcher.js — the Meteor and
  // Nuxt hosts must not diverge on what they publish.
  //
  // A host that cannot answer this is a throw, never a fall-back to `col`:
  // silently serving unwindowed documents is the exact failure this guards.
  if (typeof ontologize.publicCollection !== "function") {
    throw new Error(
      "cellFetcher: the ontologize instance does not implement publicCollection(), " +
      "so the public-data window cannot be applied; refusing to read unwindowed"
    );
  }
  return ontologize.publicCollection(name);
}

/**
 * Fetch the contents of a single H3 cell.
 *
 * @param {Object} args
 * @param {Object} args.ontologize              — Ontologize instance (.collections used to resolve `collection`)
 * @param {string} args.collection              — registered collection name (key into ontologize.collections)
 * @param {Object} [args.baseSelector={}]       — additional Mongo selector
 * @param {string} args.cellId                  — H3 cell id (any stored resolution)
 * @param {number} [args.maxRaw=1000]           — count above this returns a cluster
 * @param {string} [args.groupProperty]         — when set, cluster includes groupClusters
 *
 * @returns {Promise<{
 *   cellId: string,
 *   resolution: number,
 *   count: number,
 *   shape: "raw" | "cluster",
 *   docs?: Object[],
 *   cluster?: {
 *     centroid: { lat: number, lng: number },
 *     timeRange: { startMs: number, endMs: number } | null,
 *     groupClusters?: Array<{
 *       groupId:   string|null,
 *       count:     number,
 *       centroid:  { lat: number, lng: number },
 *       timeRange: { startMs: number, endMs: number } | null,
 *       buckets:   Array<{ minMs: number, maxMs: number } | null>
 *                            // length CLUSTER_BUCKET_COUNT (or 1 zero-span);
 *                            // null = empty bucket; non-null = actual doc
 *                            // time bounds within that bucket window. §18.10
 *     }>
 *   }
 * }>}
 */
export async function getDocsInCell({
  ontologize,
  collection,
  baseSelector = {},
  cellId,
  maxRaw = 1000,
  groupProperty,
}) {
  if (!h3.isValidCell(cellId)) {
    throw new Error(`Invalid H3 cell: ${cellId}`);
  }
  const resolution = h3.getResolution(cellId);
  const fieldName = h3FieldName(resolution); // throws if resolution isn't stored

  const col = await resolveCollection(ontologize, collection);
  const match = { ...baseSelector, [fieldName]: cellId };

  // Probe with a +1 limit so we can tell raw-vs-summary in one round trip.
  const probe = await col.find(match).limit(maxRaw + 1).toArray();

  if (probe.length <= maxRaw) {
    return {
      cellId,
      resolution,
      count: probe.length,
      shape: "raw",
      docs: probe,
    };
  }

  // Over the threshold — compute the cluster via $facet.
  const facets = {
    cluster: [
      { $group: {
        _id: null,
        count:     { $sum: 1 },
        avgLat:    { $avg: "$geo:lat" },
        avgLng:    { $avg: "$geo:long" },
        minWhenMs: { $min: "$_whenMs" },
        maxWhenMs: { $max: "$_whenMs" },
      }},
    ],
  };
  if (groupProperty) {
    // Per-group sub-clusters: count + centroid + time bounds per distinct
    // value of `groupProperty`, top-N by count. Powers per-individual cluster
    // rendering (§18.4 PR-4), density-contour weighting (§18.5 PR-5), and
    // per-group time-window hiding in TimeScrubberPlugin (§18.7 #5 fix —
    // without this, a cluster shows whenever ANY animal in the cell has docs
    // in the scrubber window, not just the selected one).
    facets.groupClusters = [
      { $group: {
        _id:       `$${groupProperty}`,
        count:     { $sum: 1 },
        avgLat:    { $avg: "$geo:lat" },
        avgLng:    { $avg: "$geo:long" },
        minWhenMs: { $min: "$_whenMs" },
        maxWhenMs: { $max: "$_whenMs" },
        // $push the raw doc timestamps so we can bin them in JS post-
        // aggregation (§18.10). Memory cost is ~8 bytes × total docs per
        // group during aggregation; sort/limit happens after this push, so
        // the cost is for ALL groups in the cell, not just top-N.
        // Acceptable at expected cell densities; promote to ingest-time
        // pre-bucketing (§18.10.3 option C) if profiling demands.
        whenMsList: { $push: "$_whenMs" },
      }},
      { $sort: { count: -1 } },
      { $limit: TOP_GROUPS_LIMIT },
    ];
  }

  const [facet] = await col.aggregate([{ $match: match }, { $facet: facets }]).toArray();
  const c = facet?.cluster?.[0];
  const groupClusters = facet?.groupClusters?.map(g => ({
    groupId:  g._id ?? null,
    count:    g.count,
    centroid: { lat: g.avgLat ?? null, lng: g.avgLng ?? null },
    timeRange: (g.minWhenMs != null && g.maxWhenMs != null)
      ? { startMs: g.minWhenMs, endMs: g.maxWhenMs }
      : null,
    buckets: binTimes(g.whenMsList, g.minWhenMs, g.maxWhenMs),
  }));

  const timeRange = (c?.minWhenMs != null && c?.maxWhenMs != null)
    ? { startMs: c.minWhenMs, endMs: c.maxWhenMs }
    : null;

  return {
    cellId,
    resolution,
    count: c?.count ?? 0,
    shape: "cluster",
    cluster: {
      centroid: { lat: c?.avgLat ?? null, lng: c?.avgLng ?? null },
      timeRange,
      ...(groupClusters ? { groupClusters } : {}),
    },
  };
}

/**
 * Batch fetcher — parallel `getDocsInCell` per cellId. Returns a map keyed
 * by cellId so the client can look up results without ordering assumptions.
 *
 * Optimized form (single multi-cell aggregation) is deferred until profiling
 * demands it.
 *
 * @returns {Promise<{ results: Record<string, CellResponse> }>}
 */
export async function getDocsInCells({
  ontologize,
  collection,
  baseSelector = {},
  cellIds,
  maxRaw = 1000,
  groupProperty,
}) {
  if (!Array.isArray(cellIds)) {
    throw new Error("cellIds must be an array");
  }
  const results = {};
  await Promise.all(cellIds.map(async (cellId) => {
    results[cellId] = await getDocsInCell({
      ontologize, collection, baseSelector, cellId, maxRaw, groupProperty,
    });
  }));
  return { results };
}
