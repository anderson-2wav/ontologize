/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * H3 helpers for the GeoView cell-cache architecture.
 *
 * Pure: no Mongo, no Meteor. Wraps `h3-js` with the resolution policy and
 * field-name conventions that the rest of the system depends on.
 *
 * The data model stores `_h3` at resolution 15 (max precision) plus a small
 * set of parent-cell fields (`_h3_3, _h3_5, _h3_7, _h3_9, _h3_11`) so that
 * a query at any displayed zoom is a single-field equality lookup.
 */

import * as h3 from "h3-js";

/** Resolution stored at full precision in the `_h3` field. */
export const FINE_RESOLUTION = 15;

/**
 * Resolutions stored as parent-cell fields. A query at any displayed zoom is
 * mapped (via zoomToH3Resolution) to one of these.
 */
export const PARENT_RESOLUTIONS = [3, 5, 7, 9, 11];

/** All resolutions that have a stored field on each doc. */
export const STORED_RESOLUTIONS = [...PARENT_RESOLUTIONS, FINE_RESOLUTION];

/**
 * Mongo field name that stores the cell at a given resolution.
 * Throws for resolutions we don't store, so wrong call sites surface early.
 */
export function h3FieldName(resolution) {
  if (resolution === FINE_RESOLUTION) return "_h3";
  if (PARENT_RESOLUTIONS.includes(resolution)) return `_h3_${resolution}`;
  throw new Error(
    `geoH3: no stored field for H3 resolution ${resolution}; expected one of [${STORED_RESOLUTIONS.join(", ")}]`
  );
}

/**
 * Map a Leaflet zoom level to one of our stored H3 resolutions.
 *
 * Calibrated so a typical Leaflet viewport contains ~10–200 covering cells —
 * a manageable parallel-fetch fan-out. Each H3 step is ~7×
 * finer area; each Leaflet zoom step is 4× area; so ~3 zoom levels per
 * resolution step.
 *
 * | zoom    | res | cell edge | buffered cells in 1200×800 viewport |
 * |---------|-----|-----------|-------------------------------------|
 * | ≤ 7     | 3   | ~70 km    | 132 at z7 (much higher at z≤6 — see note) |
 * | 8–11    | 5   | ~10 km    | 37 (z11) – 1 264 (z8) |
 * | 12–14   | 7   | ~1.5 km   | 31 (z14) – 282 (z12) |
 * | 15–17   | 9   | ~200 m    | 25 (z17) – 223 (z15) |
 * | ≥ 18    | 11  | ~30 m     | 176 at z18 |
 *
 * NOTE: at z ≤ 6 (continental/world view) res 3 yields thousands of cells
 * because we don't store coarser parent fields. If those zooms become a real
 * use case, add `_h3_1` (~120 cells globally) to STORED_RESOLUTIONS.
 *
 * Always returns an element of PARENT_RESOLUTIONS, regardless of input.
 */
export function zoomToH3Resolution(zoom) {
  if (typeof zoom !== "number" || isNaN(zoom)) return PARENT_RESOLUTIONS[0];
  if (zoom <= 7)  return 3;
  if (zoom <= 11) return 5;
  if (zoom <= 14) return 7;
  if (zoom <= 17) return 9;
  return 11;
}

/**
 * Cells overlapping the bbox at the given resolution.
 *
 * Combines two strategies so the result is robust:
 *   1. `polygonToCells` returns cells whose CENTERS fall inside the bbox.
 *      Picks up the bulk of any normal viewport.
 *   2. Explicitly add the cells at each corner and at the bbox center.
 *      Catches edge cells (whose center is just outside the bbox but whose
 *      area overlaps it) and handles sub-cell bboxes where polygonToCells
 *      returns nothing because no cell center happens to be inside.
 *
 * The resulting set is a superset of center-coverage; cell centers may sit
 * up to ~one cell-edge outside the bbox. The bufferRing step downstream
 * compensates for any remaining edge effects.
 *
 * @param {{minLat:number, maxLat:number, minLng:number, maxLng:number}} bbox
 * @param {number} resolution
 * @returns {string[]} cell ids (15-char hex strings)
 */
export function bboxToH3Cells(bbox, resolution) {
  const ring = [
    [bbox.minLat, bbox.minLng],
    [bbox.minLat, bbox.maxLng],
    [bbox.maxLat, bbox.maxLng],
    [bbox.maxLat, bbox.minLng],
    [bbox.minLat, bbox.minLng], // close
  ];
  const set = new Set(h3.polygonToCells(ring, resolution));
  set.add(h3.latLngToCell(bbox.minLat, bbox.minLng, resolution));
  set.add(h3.latLngToCell(bbox.minLat, bbox.maxLng, resolution));
  set.add(h3.latLngToCell(bbox.maxLat, bbox.maxLng, resolution));
  set.add(h3.latLngToCell(bbox.maxLat, bbox.minLng, resolution));
  set.add(h3.latLngToCell(
    (bbox.minLat + bbox.maxLat) / 2,
    (bbox.minLng + bbox.maxLng) / 2,
    resolution,
  ));
  return [...set];
}

/**
 * Union of input cells with each cell's k-ring of neighbors.
 *
 * Uses h3-js `gridDisk(cell, k)`, which returns the cell itself plus all
 * cells within k rings (so a 1-ring buffer for one input hex returns 7 cells,
 * or 6 if the input is one of the 12 pentagons).
 *
 * @param {string[]} cellIds
 * @param {number} [k=1]
 * @returns {string[]} deduplicated cell ids
 */
export function bufferRing(cellIds, k = 1) {
  const out = new Set();
  for (const c of cellIds) {
    for (const n of h3.gridDisk(c, k)) out.add(n);
  }
  return [...out];
}
