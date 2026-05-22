/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * addH3 — backfill `_h3` (resolution-15 cell) and parent-resolution fields
 * on every doc in a collection that has geo:lat/long.
 *
 * Idempotent: docs that already have `_h3` are skipped unless
 * `force: true`. Also creates indexes for `_h3` and each parent field —
 * `createIndex` is a no-op when the index already exists.
 *
 * Pure server logic. No HTTP, no Meteor. Caller passes an Ontologize
 * instance whose `.collections` map resolves the collection name (same
 * pattern as cellFetcher.js — see this directory's README).
 */

import * as h3 from "h3-js";
import { FINE_RESOLUTION, PARENT_RESOLUTIONS } from "./h3.js";

/** Field names this routine writes + indexes, in write order. */
export const ADD_H3_FIELDS = ["_h3", ...PARENT_RESOLUTIONS.map(r => `_h3_${r}`)];

/**
 * Backfill H3 cell fields on every doc with geo:lat/long.
 *
 * @param {Object} args
 * @param {Object} args.ontologize          — Ontologize instance (.collections used to resolve `collection`)
 * @param {string} args.collection          — registered collection name (key into ontologize.collections)
 * @param {boolean} [args.force=false]      — recompute even when `_h3` is already set
 *
 * @returns {Promise<{
 *   updated:    number,        // docs whose _h3 / _h3_R fields were written
 *   skipped:    number,        // docs ignored because geo:lat/long were invalid
 *   indexed:    string[],      // field names ensured (createIndex'd) on this run
 *   durationMs: number,
 * }>}
 */
export async function addH3({ ontologize, collection, force = false }) {
  const col = ontologize?.collections?.[collection];
  if (!col) {
    const known = Object.keys(ontologize?.collections ?? {}).join(", ") || "(none)";
    throw new Error(`Unknown collection "${collection}". Known: ${known}`);
  }

  const t0 = Date.now();

  for (const field of ADD_H3_FIELDS) {
    await col.createIndex({ [field]: 1 });
  }

  const filter = { "geo:lat": { $exists: true }, "geo:long": { $exists: true } };
  if (!force) filter._h3 = { $exists: false };

  const cursor = col.find(filter);
  let updated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const lat = doc["geo:lat"];
    const lng = doc["geo:long"];

    if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
      skipped++;
      continue;
    }

    const fine = h3.latLngToCell(lat, lng, FINE_RESOLUTION);
    const update = { _h3: fine };
    for (const r of PARENT_RESOLUTIONS) {
      update[`_h3_${r}`] = h3.cellToParent(fine, r);
    }

    await col.updateOne({ _id: doc._id }, { $set: update });
    updated++;
  }

  return { updated, skipped, indexed: ADD_H3_FIELDS, durationMs: Date.now() - t0 };
}
