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
 * @param {object} opts
 * @param {object} [opts.selector={}] - match stage for the geo collection
 * @param {string} opts.groupProperty - property naming the group, e.g. "bold:animal"
 * @param {string} opts.cellField - stored H3 field, e.g. "_h3_7"
 * @param {string} [opts.timeProperty="_whenMs"] - epoch-ms field to bound
 * @returns {Array<object>} aggregation pipeline
 */
export function buildSummaryPipeline({ selector = {}, groupProperty, cellField, timeProperty = "_whenMs" } = {}) {
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
      const prev = out.get(id);
      if (!prev) {
        out.set(id, {
          firstMs: row.firstMs ?? null,
          lastMs:  row.lastMs ?? null,
          count:   row.count ?? 0,
          cells:   new Set(cells),
        });
        continue;
      }
      prev.firstMs = minOrNull(prev.firstMs, row.firstMs);
      prev.lastMs  = maxOrNull(prev.lastMs, row.lastMs);
      prev.count  += row.count ?? 0;
      for (const cell of cells) prev.cells.add(cell);
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
