/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Polyline and polygon simplification — Douglas–Peucker, used to derive a
 * thumbnail-scale depiction from a full-detail one. The merged State of
 * Illinois is 21,667 vertices; at the ~100px the ResourceViewer panel gives it,
 * roughly 200 will do.
 *
 * Douglas–Peucker rather than Visvalingam–Whyatt because its defining property
 * is exactly the requirement here: no retained outline deviates from the
 * original by more than `tolerance`. Visvalingam discards by triangle area and
 * offers no displacement bound, so "invisible at this size" would be something
 * you eyeball rather than something a test can assert.
 *
 * Pure geometry: no Mongo, no Meteor, no node built-ins. The instance-bound
 * wrapper that pairs a detail shape with its thumbnail is
 * `GeoApi#buildDepictions`.
 */

import { geoArea } from "./merge.js";

/**
 * Default maximum vertex displacement, in degrees of latitude (~1.1 km).
 *
 * Sized against the intended render: Illinois spans 5.538° of latitude, so at
 * 100px tall one pixel is ~0.055°. This tolerance is therefore a worst-case
 * error of ~0.18px — provably invisible, and still sub-pixel if the same shape
 * is later drawn at 500px.
 */
export const DEFAULT_TOLERANCE = 0.01;

/** A closed ring needs three distinct vertices plus the repeated first. */
export const DEFAULT_MIN_RING_VERTICES = 4;

/** The only geometry types this can consume. Matches merge.js. */
const AREAL_TYPES = new Set(["Polygon", "MultiPolygon"]);

/**
 * Distance from `p` to the segment `a`–`b`, in the plane.
 *
 * Segment rather than infinite line: when a ring is split, the two endpoints
 * can coincide, and the perpendicular to a zero-length line is undefined.
 *
 * @param {[number, number]} p
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 * @private
 */
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas–Peucker over an open polyline in a planar frame.
 *
 * Iterative with an explicit stack rather than recursive: a 21,667-vertex ring
 * can nest deeply enough to matter, and the recursive form is the one that
 * blows the stack on adversarial input.
 *
 * Points are only ever dropped, never moved or reordered, which is why winding
 * survives simplification for free.
 *
 * @param {Array<[number, number]>} points - planar [x, y], open (not closed)
 * @param {number} tolerance - maximum displacement, in the same units
 * @returns {Array<[number, number]>} the retained points, in input order
 */
export function simplifyRing(points, tolerance) {
  const n = points.length;
  if (n <= 2 || !(tolerance > 0)) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const dist = segmentDistance(points[i], points[first], points[last]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }

    if (maxDist > tolerance && index > first) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/** True when a ring's last position repeats its first. @private */
function isClosed(ring) {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Simplify one [lng, lat] ring, returning a closed ring or null.
 *
 * Two details that are easy to get wrong:
 *
 * - **The ring is opened first.** Feeding Douglas–Peucker a closed ring makes
 *   its first and last points identical, so the initial split has nowhere to go
 *   and the result is degenerate.
 * - **Longitude is scaled by cos(meanLat)** so `tolerance` means the same
 *   distance in both axes. Without it, a degree of longitude at Illinois'
 *   latitude is ~23% shorter than a degree of latitude, and the simplification
 *   is visibly more aggressive east–west. This is the frame `range.js` uses
 *   before hulling, for the same reason.
 *
 * Douglas–Peucker always retains a polyline's two endpoints. On a ring those
 * are the start vertex and whatever happens to precede it — an arbitrary
 * position that then survives at any tolerance, leaving a stray vertex in the
 * middle of what should be a straight run. So the ring is split at the point
 * *farthest* from its start and simplified as two polylines: the two retained
 * anchors are then genuine extremes, which any tolerance would keep anyway.
 *
 * @param {Array<[number, number]>} ring - [lng, lat] positions
 * @param {number} tolerance - degrees of latitude
 * @param {number} scale - cos(meanLat), the longitude correction
 * @returns {Array<[number, number]>|null} a closed ring, or null if degenerate
 * @private
 */
function simplifyLngLatRing(ring, tolerance, scale) {
  if (!Array.isArray(ring) || ring.length < 4) return null;

  const open = isClosed(ring) ? ring.slice(0, -1) : ring.slice();
  if (open.length < 3) return null;

  const planar = open.map(([lng, lat]) => [lng * scale, lat]);

  let far = 0;
  let farDist = -1;
  for (let i = 1; i < planar.length; i++) {
    const d = Math.hypot(planar[i][0] - planar[0][0], planar[i][1] - planar[0][1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  if (far < 1) return null;

  // The second span runs from the far anchor back round to the start, whose
  // repeat is dropped: the caller re-closes.
  const head = simplifyRing(planar.slice(0, far + 1), tolerance);
  const tail = simplifyRing([...planar.slice(far), planar[0]], tolerance);
  const kept = head.concat(tail.slice(1, -1));
  if (kept.length < 3) return null;

  const out = kept.map(([x, y]) => [x / scale, y]);
  out.push([out[0][0], out[0][1]]);
  return out;
}

/** Every position in a Polygon/MultiPolygon coordinate tree. @private */
function positionsOfPolygons(polygons) {
  const out = [];
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const position of ring) out.push(position);
    }
  }
  return out;
}

/** Unwrap a Feature to its geometry; pass a bare geometry through. @private */
function geometryOf(shape) {
  if (!shape || typeof shape !== "object") return null;
  if (shape.type === "Feature") return shape.geometry ?? null;
  return shape;
}

/**
 * Simplify an areal shape, returning a GeoJSON Feature.
 *
 * Winding is preserved, which matters more than it sounds: d3-geo reads a
 * counterclockwise exterior as *the whole sphere minus* the polygon, so a shape
 * that flipped during simplification renders as a filled rectangle rather than
 * failing visibly. See merge.js's `WINDINGS` note. Douglas–Peucker only
 * deletes, so this comes for free — the tests assert it anyway.
 *
 * Interior rings are simplified too, and one that collapses below
 * `minRingVertices` is dropped and counted. An exterior ring that collapses
 * takes its polygon with it, holes included, rather than leaving orphaned
 * interior rings behind.
 *
 * Self-intersection is theoretically possible and not guarded against;
 * detecting it costs more than the whole function, and at sub-pixel tolerances
 * it does not arise in practice.
 *
 * @param {object} shape - Feature, Polygon or MultiPolygon
 * @param {object} [opts]
 * @param {number} [opts.tolerance=DEFAULT_TOLERANCE] - max displacement, in
 *   degrees of latitude
 * @param {number} [opts.minRingVertices=4] - rings below this are dropped
 * @param {object} [opts.properties] - properties for the resulting Feature
 * @param {boolean} [opts.diagnostics=true] - attach `bold:simplifyDiagnostics`
 * @returns {object|null} a GeoJSON Feature, or null if nothing areal survived
 */
export function simplifyShape(shape, opts = {}) {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const minRingVertices = opts.minRingVertices ?? DEFAULT_MIN_RING_VERTICES;

  const source = geometryOf(shape);
  if (!source || !AREAL_TYPES.has(source.type)) return null;

  const polygons = source.type === "Polygon" ? [source.coordinates] : source.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0) return null;

  const positions = positionsOfPolygons(polygons);
  if (positions.length === 0) return null;

  const meanLat = positions.reduce((n, p) => n + p[1], 0) / positions.length;
  const scale = Math.cos((meanLat * Math.PI) / 180) || 1;

  let ringsIn = 0;
  let ringsOut = 0;
  let ringsDropped = 0;
  let verticesOut = 0;
  const outPolygons = [];

  for (const poly of polygons) {
    ringsIn += poly.length;

    // The exterior ring decides the polygon's fate: without it there is no
    // area for a hole to subtract from.
    const exterior = simplifyLngLatRing(poly[0], tolerance, scale);
    if (!exterior) {
      ringsDropped += poly.length;
      continue;
    }

    const rings = [exterior];
    for (let i = 1; i < poly.length; i++) {
      const hole = simplifyLngLatRing(poly[i], tolerance, scale);
      if (hole) rings.push(hole);
      else ringsDropped++;
    }

    for (const ring of rings) verticesOut += ring.length;
    ringsOut += rings.length;
    outPolygons.push(rings);
  }

  if (outPolygons.length === 0) return null;

  const geometry = outPolygons.length === 1
    ? { type: "Polygon", coordinates: outPolygons[0] }
    : { type: "MultiPolygon", coordinates: outPolygons };

  const properties = { ...(opts.properties ?? {}) };

  if (opts.diagnostics !== false) {
    const areaIn = geoArea(source);
    const areaOut = geoArea(geometry);
    properties["bold:simplifyDiagnostics"] = {
      tolerance,
      verticesIn: positions.length,
      verticesOut,
      ringsIn,
      ringsOut,
      ringsDropped,
      areaKm2: Number((areaOut / 1e6).toFixed(2)),
      // The "is this still the same shape" check, and the analogue of
      // mergeShapes' holesDropped: a simplification that moved area moved the
      // outline, whatever the vertex counts say.
      areaDeltaPct: areaIn === 0 ? 0 : Number((((areaOut - areaIn) / areaIn) * 100).toFixed(4))
    };
  }

  return { type: "Feature", properties, geometry };
}

export default simplifyShape;
