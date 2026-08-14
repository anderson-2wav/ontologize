/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Pure helpers behind `GeoApi.getGroupSummary` — the per-group facts the
 * GeoView animal selector filters on. No Mongo, no Meteor: the pipeline is
 * built as data and handed to a collection by the caller.
 *
 * See `.private/specs/crittertrack/animal-selector-filters-spec.md` §4.
 */

import { cellToLatLng, isValidCell } from "h3-js";
import { pointInGeometry } from "./pointInPolygon.js";

/**
 * The aggregation that reduces a geo collection to one row per group.
 *
 * `$addToSet` on the cell field is what keeps the payload bounded: 761 cells
 * stand in for 32,732 points at H3 resolution 7. The caller enforces a ceiling
 * on the total (see GeoApi.getGroupSummary) because `$addToSet` itself has none.
 *
 * `includeLastPoint` is opt-in rather than always-on because the two callers
 * want opposite things. The animal roster runs this pipeline over every animal
 * on every filter change and needs no position; the per-animal info panel runs
 * it for one animal and needs exactly one. `$top` sorts within each group, so
 * making it unconditional would put a per-group sort on the roster path to
 * serve a field the roster discards.
 *
 * `$top` (MongoDB 5.2+) rather than a `$sort` stage before `$group`: sorting
 * the whole geo collection to learn one document per group is the expensive
 * way to ask. Note its output array elides missing paths, so a newest document
 * carrying no position yields `[]` — `mergeSummaries` is what rejects that.
 *
 * @param {object} opts
 * @param {object} [opts.selector={}] - match stage for the geo collection
 * @param {string} opts.groupProperty - property naming the group, e.g. "bold:animal"
 * @param {string} opts.cellField - stored H3 field, e.g. "_h3_7"
 * @param {string} [opts.timeProperty="_whenMs"] - epoch-ms field to bound
 * @param {boolean} [opts.includeLastPoint=false] - also accumulate the position
 *   of the newest document in each group, as `lastPoint`
 * @param {string} [opts.latProperty="geo:lat"] - latitude field, when included
 * @param {string} [opts.lngProperty="geo:long"] - longitude field, when included
 * @returns {Array<object>} aggregation pipeline
 */
export function buildSummaryPipeline({
  selector = {}, groupProperty, cellField, timeProperty = "_whenMs",
  includeLastPoint = false, latProperty = "geo:lat", lngProperty = "geo:long",
} = {}) {
  if (typeof groupProperty !== "string" || groupProperty.length === 0) {
    throw new Error("buildSummaryPipeline: groupProperty is required");
  }
  if (typeof cellField !== "string" || cellField.length === 0) {
    throw new Error("buildSummaryPipeline: cellField is required");
  }
  return [
    { $match: selector },
    { $group: {
      _id:     `$${groupProperty}`,
      firstMs: { $min: `$${timeProperty}` },
      lastMs:  { $max: `$${timeProperty}` },
      count:   { $sum: 1 },
      cells:   { $addToSet: `$${cellField}` },
      // Sorted by the same clock as firstMs/lastMs, so the point returned is
      // the one whose time `lastMs` already reports — the caller needs no
      // second timestamp.
      ...(includeLastPoint ? {
        lastPoint: { $top: {
          sortBy: { [timeProperty]: -1 },
          output: [`$${latProperty}`, `$${lngProperty}`],
        } },
      } : {}),
    } },
  ];
}

/** @private */
function minOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/** @private */
function maxOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

/**
 * A `[lat, lng]` pair, or null for anything else.
 *
 * `$top`'s output array elides missing field paths, so a group whose newest
 * document carries no position arrives as `[]` and one missing a single
 * coordinate as `[41.9]` — both must read as "no position" rather than as a
 * half-position that would render as `41.9, undefined`.
 *
 * @private
 */
function pointOrNull(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lat, lng] = value;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

/**
 * Fold several aggregation result sets into one map of group facts.
 *
 * The multi-collection case is real: `GroupFilterContent` already merges a
 * `queries` list and dedupes by `_id`, so the same animal seen through two
 * collections must produce one row — earliest first, latest last, summed
 * count, unioned cells.
 *
 * Rows whose `_id` is null are dropped, matching the `.filter(Boolean)` in
 * `geo.getGroupResources`: a geo document with no group property names no group.
 * Null cells are dropped the same way, so a collection that never ran `addH3`
 * yields an empty set rather than a set containing null.
 *
 * @param {Array<Array<object>>} batches
 * @returns {Map<string, {firstMs: number|null, lastMs: number|null, count: number, cells: Set<string>}>}
 */
export function mergeSummaries(batches) {
  const out = new Map();
  for (const rows of batches ?? []) {
    for (const row of rows ?? []) {
      const id = row?._id;
      if (typeof id !== "string" || id.length === 0) continue;

      const cells = (row.cells ?? []).filter(c => typeof c === "string" && c.length > 0);
      const point = pointOrNull(row.lastPoint);
      // The point's own time, not the group's. They differ when the newest
      // document in a batch carries no position: `lastMs` still reports it,
      // but the position on offer belongs to an earlier fix, and pairing the
      // two would render a fix that never happened.
      const pointMs = point ? (row.lastMs ?? null) : null;

      const prev = out.get(id);
      if (!prev) {
        out.set(id, {
          firstMs: row.firstMs ?? null,
          lastMs:  row.lastMs ?? null,
          count:   row.count ?? 0,
          cells:   new Set(cells),
          lastPoint:   point,
          lastPointMs: pointMs,
        });
        continue;
      }
      prev.firstMs = minOrNull(prev.firstMs, row.firstMs);
      prev.lastMs  = maxOrNull(prev.lastMs, row.lastMs);
      prev.count  += row.count ?? 0;
      for (const cell of cells) prev.cells.add(cell);
      // Batch order says nothing about recency, so the newer point wins on its
      // timestamp. A point with no timestamp only fills an empty slot.
      if (point && (prev.lastPoint === null || (pointMs ?? -Infinity) > (prev.lastPointMs ?? -Infinity))) {
        prev.lastPoint   = point;
        prev.lastPointMs = pointMs;
      }
    }
  }
  return out;
}

/**
 * Resolve H3 cell ids to `[lat, lng]` centroids.
 *
 * The server resolves these rather than shipping cell ids because it needs the
 * centroids anyway for `tagRegions`, and a resolved pair costs the same on the
 * wire (~19 bytes against ~17). The client then measures distances with no
 * `h3-js` dependency and no knowledge of the H3 encoding.
 *
 * Rounding to 4 decimals is ~11 m — far finer than the ~1.2 km cell whose
 * centre this is, and it keeps the payload compact.
 *
 * @param {Iterable<string>} cellIds - cell ids; a Set is fine
 * @param {number} [precision=4] - decimal places
 * @returns {Array<[number, number]>} [lat, lng] pairs
 */
export function centroidsForCells(cellIds, precision = 4) {
  const out = [];
  const factor = 10 ** precision;
  for (const id of cellIds ?? []) {
    if (typeof id !== "string" || id.length === 0 || !isValidCell(id)) continue;
    try {
      const [lat, lng] = cellToLatLng(id);
      out.push([Math.round(lat * factor) / factor, Math.round(lng * factor) / factor]);
    }
    catch (err) {
      // A cell id the importer never wrote, or wrote at a resolution h3-js
      // rejects. One bad cell must not fail a roster request.
    }
  }
  return out;
}

/**
 * Which regions a group touches, under the "any point" rule: a group belongs to
 * a region if **any** of its centroids falls inside it. An animal near a
 * boundary therefore appears under both regions, which is the intended reading
 * of "show me the animals in the South" — see the spec §2 decision table.
 *
 * A region whose geometry is missing or is not a Polygon/MultiPolygon is
 * skipped, not fatal: a misconfigured region must never blank the roster.
 *
 * @param {Array<[number, number]>} centroids - [lat, lng] pairs
 * @param {Array<{_id: string, geometry: object}>} regions
 * @returns {string[]} region ids, in the order the regions were given
 */
/**
 * The set key an unkeyed region config gets. Named for the filter it drives on
 * the client, which is where the key surfaces (`meta.regionSets.region`).
 */
export const DEFAULT_REGION_SET_KEY = "region";

/** Where a region set's geometry lives, absent a `geometryProperty`. */
export const DEFAULT_REGION_GEOMETRY_PROPERTY = "bold:spatialDepiction";

/**
 * Normalize the `regions` option into a list of keyed region sets.
 *
 * A caller may tag groups against **several independent region schemes** at
 * once — IDNR's three administrative regions and its five wildlife-management
 * regions are two different partitions of the same 102 counties, not a
 * hierarchy, and an animal carries tags from both. Each set gets a `key` so the
 * client can tell one scheme's tags from another's in the returned catalog.
 *
 * The single-object form is the original contract and still works, normalizing
 * to one set keyed `"region"` — so every existing caller is unaffected.
 *
 * Nothing here is Illinois-specific; the keys and selectors are configuration,
 * which is the property that keeps this in the LGPL module at all. See the spec
 * §3, "Nothing server-side is Illinois-specific".
 *
 * A duplicate key would make two schemes indistinguishable in the catalog, so
 * the later one is dropped rather than silently shadowing — a config error that
 * degrades like every other region misconfiguration rather than throwing.
 *
 * @param {object|Array<object>|null} regions - one config or a list of them
 * @returns {Array<{key: string, collection: string, selector: object, geometryProperty: string}>}
 */
export function normalizeRegionSets(regions) {
  if (!regions) return [];
  const list = Array.isArray(regions) ? regions : [regions];

  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry?.collection) continue;
    const key = entry.key ?? DEFAULT_REGION_SET_KEY;
    if (seen.has(key)) {
      console.warn(`getGroupSummary: duplicate region set key "${key}" — ignoring the later one`);
      continue;
    }
    seen.add(key);
    out.push({
      key,
      collection: entry.collection,
      selector: entry.selector ?? {},
      geometryProperty: entry.geometryProperty ?? DEFAULT_REGION_GEOMETRY_PROPERTY,
    });
  }
  return out;
}

export function tagRegions(centroids, regions) {
  const tags = [];
  for (const region of regions ?? []) {
    if (!region?._id || !region.geometry) continue;
    // GeoJSON is [lng, lat]; centroids are [lat, lng]. Swap here, once.
    const hit = (centroids ?? []).some(([lat, lng]) => pointInGeometry([lng, lat], region.geometry));
    if (hit) tags.push(region._id);
  }
  return tags;
}
