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
