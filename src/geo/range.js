/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Spatial range — the hull enclosing a set of GeoJSON, used to describe where
 * something has been: an animal's home range from its tracking reports.
 *
 * Where `mergeShapes` unions areas and keeps their outline exactly, this throws
 * a boundary around scattered geometry. It reads *positions*, not areas, so a
 * mix of points, lines and polygons is normal input — every vertex counts the
 * same, and one lone tracking point contributes as much as a county's border.
 *
 * Pure geometry: no Mongo, no Meteor, no node built-ins. The instance-bound
 * wrapper that turns resources into depictions is `GeoApi#getSpatialRange`.
 */

import { Delaunay } from "d3-delaunay";
import { geoArea } from "./merge.js";

/** Hull shapes this understands. */
export const HULL_TYPES = ["convex", "concave"];

/**
 * Default concavity. Matches `RangeExtentPlugin`'s `concaveAlpha`, so a range
 * computed here is the shape the plugin already draws for the same points.
 */
export const DEFAULT_ALPHA = 0.5;

/**
 * Collect every position in a GeoJSON object, at any nesting depth.
 *
 * Deliberately blind to geometry type: a range is about where things are, and
 * a polygon's vertices say that as well as a point does. Non-areal geometry is
 * therefore ordinary input here, unlike in `mergeShapes` where it is skipped.
 *
 * @param {object} geo - any GeoJSON object
 * @returns {Array<[number, number]>} [lng, lat] positions, in encounter order
 */
export function positionsOf(geo) {
  if (!geo) return [];
  if (geo.type === "FeatureCollection") return (geo.features ?? []).flatMap(positionsOf);
  if (geo.type === "Feature") return positionsOf(geo.geometry);
  if (geo.type === "GeometryCollection") return (geo.geometries ?? []).flatMap(positionsOf);

  const coords = geo.coordinates;
  if (!coords) return [];

  // A position is the innermost array of numbers; everything above it is
  // nesting that varies by type (Point → 0 levels, MultiPolygon → 3).
  const walk = (node) => {
    if (!Array.isArray(node)) return [];
    if (typeof node[0] === "number") {
      return Number.isFinite(node[0]) && Number.isFinite(node[1]) ? [[node[0], node[1]]] : [];
    }
    return node.flatMap(walk);
  };
  return walk(coords);
}

/**
 * Cross product of OA→OB and OA→OC. Positive when OABC turns counterclockwise.
 * @private
 */
function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * Convex hull by Andrew's monotone chain — O(n log n), exact, no dependency.
 *
 * @param {Array<[number, number]>} points - planar [x, y], already deduped
 * @returns {Array<[number, number]>|null} open ring (first !== last), or null
 * @private
 */
function convexHull(points) {
  if (points.length < 3) return null;
  const pts = [...points].sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));

  const half = (source) => {
    const out = [];
    for (const p of source) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();              // last point belongs to the other half
    return out;
  };

  const hull = [...half(pts), ...half([...pts].reverse())];
  return hull.length >= 3 ? hull : null;
}

/**
 * Walk boundary edges into the longest closed ring available.
 *
 * An alpha shape's boundary can come back as several loops — an outer ring plus
 * islands the threshold cut loose. Taking the longest closed one keeps the
 * result a simple polygon; a naive single traversal can instead stop partway
 * and hand back a ring that crosses itself.
 *
 * @param {Array<{i: number, j: number}>} edges
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>|null} open ring, or null
 * @private
 */
function ringFromEdges(edges, points) {
  const adjacency = new Map();
  for (const { i, j } of edges) {
    if (!adjacency.has(i)) adjacency.set(i, []);
    if (!adjacency.has(j)) adjacency.set(j, []);
    adjacency.get(i).push(j);
    adjacency.get(j).push(i);
  }

  const seen = new Set();
  let best = null;

  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;

    const loop = [];
    const local = new Set();
    let current = start;

    while (current !== undefined && !local.has(current)) {
      local.add(current);
      seen.add(current);
      loop.push(current);
      current = (adjacency.get(current) ?? []).find((n) => !local.has(n));
    }

    // Only keep it if it actually closed — the last vertex must touch the first.
    const closes = loop.length >= 3 && (adjacency.get(loop[loop.length - 1]) ?? []).includes(start);
    if (closes && (!best || loop.length > best.length)) best = loop;
  }

  return best ? best.map((i) => points[i]) : null;
}

/**
 * Concave hull (alpha shape) by Delaunay triangulation with edge-length
 * filtering. Triangles whose longest edge exceeds the threshold are dropped;
 * what remains is bounded by the edges belonging to exactly one triangle.
 *
 * The threshold interpolates between the median and the longest edge in the
 * triangulation, so `alpha` is relative to the point set's own spacing rather
 * than an absolute distance — the same value behaves sensibly for a home range
 * and for a continent. `alpha: 0` keeps everything, which is the convex hull.
 *
 * Same rule as `bold-vue/geo-plugins/hullUtils.js`, which is what `RangeExtentPlugin`
 * draws, so a stored range agrees with the live overlay.
 *
 * @param {Array<[number, number]>} points - planar [x, y], already deduped
 * @param {number} alpha - 0 (convex) … 1 (most concave)
 * @returns {Array<[number, number]>|null} open ring, or null
 * @private
 */
function concaveHull(points, alpha) {
  // Delaunator needs 4+ points to produce a triangle set worth filtering.
  if (points.length < 4) return convexHull(points);

  const triangles = Delaunay.from(points).triangles;
  if (triangles.length === 0) return convexHull(points);

  const lengthOf = (i, j) => Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]);

  const longest = [];
  const all = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const ab = lengthOf(a, b), bc = lengthOf(b, c), ca = lengthOf(c, a);
    longest.push(Math.max(ab, bc, ca));
    all.push(ab, bc, ca);
  }

  all.sort((x, y) => x - y);
  const median = all[Math.floor(all.length / 2)];
  const max = all[all.length - 1];
  const threshold = max - alpha * (max - median);

  // Count how many kept triangles each edge belongs to; the boundary is the
  // edges belonging to exactly one.
  const kept = new Map();
  for (let t = 0; t < triangles.length; t += 3) {
    if (longest[t / 3] > threshold) continue;
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      const entry = kept.get(key) ?? { i, j, count: 0 };
      entry.count++;
      kept.set(key, entry);
    }
  }

  const boundary = [...kept.values()].filter((e) => e.count === 1);
  if (boundary.length < 3) return convexHull(points);

  return ringFromEdges(boundary, points) ?? convexHull(points);
}

/**
 * Signed area of a planar ring; positive when wound counterclockwise.
 * @private
 */
function signedArea(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/**
 * Mean of every position that went into the range.
 *
 * **The centre of the observations, not of the enclosed shape.** Duplicates
 * count: a collar reporting the same spot for hours pulls the mean toward it,
 * which is the point — this answers "where was the animal, on average", where a
 * polygon's centre of mass would answer "where is the middle of the boundary"
 * and ignore how the interior was used.
 *
 * Needs no planar frame. Scaling longitude by a constant and dividing it back
 * out leaves an arithmetic mean exactly where it was, unlike the area-weighted
 * calculation the hull itself requires.
 *
 * @param {Array<[number, number]>} positions - [lng, lat], duplicates included
 * @returns {[number, number]} [lng, lat]
 * @private
 */
function meanPosition(positions) {
  let lng = 0;
  let lat = 0;
  for (const [x, y] of positions) {
    lng += x;
    lat += y;
  }
  return [lng / positions.length, lat / positions.length];
}

/**
 * Compute the spatial range of a set of GeoJSON shapes as one Feature polygon.
 *
 * **The hull is computed in a local planar frame, not in degrees.** A degree of
 * longitude is shorter than a degree of latitude everywhere but the equator —
 * by 22% at Illinois' latitude — so hulling raw lng/lat stretches the point
 * cloud east-west and biases which triangles the concave filter drops. Scaling
 * longitude by cos(mean latitude) removes that, and costs one multiply.
 *
 * @param {Array<object>} shapes - GeoJSON objects: geometries, Features,
 *   FeatureCollections, or GeometryCollections, in any mix
 * @param {object} [opts]
 * @param {object} [opts.properties] - properties for the resulting Feature
 * @param {"convex"|"concave"} [opts.hullType="convex"] - boundary shape
 * @param {number} [opts.alpha=0.5] - concavity, 0…1; `concave` only
 * @param {"cw"|"ccw"} [opts.winding="cw"] - exterior-ring winding. Defaults to
 *   d3-geo's convention, which is what everything BOLD draws uses and what
 *   MongoDB's `2dsphere` reads; RFC 7946 wants `ccw`. There is no `"match"`
 *   here as there is in `mergeShapes` — a hull built from positions has no
 *   input winding to match.
 * @param {boolean} [opts.diagnostics=true] - attach `bold:rangeDiagnostics`
 * @returns {object|null} a GeoJSON Feature, or null if fewer than 3 distinct
 *   positions were given — no area can be enclosed by two points. The Feature
 *   always carries `properties.centroid`, a GeoJSON Point at the mean of every
 *   position that went in (see {@link meanPosition}), and `properties.count`,
 *   how many positions that was — duplicates included in both
 * @throws {Error} if `hullType` or `winding` is not recognised
 */
export function getSpatialRange(shapes, opts = {}) {
  const list = Array.isArray(shapes) ? shapes : (shapes ? [shapes] : []);
  const hullType = opts.hullType ?? "convex";
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const winding = opts.winding ?? "cw";

  if (!HULL_TYPES.includes(hullType)) {
    throw new Error(`getSpatialRange: unknown hullType "${hullType}" — expected one of ${HULL_TYPES.join(", ")}`);
  }
  if (winding !== "cw" && winding !== "ccw") {
    throw new Error(`getSpatialRange: unknown winding "${winding}" — expected cw or ccw`);
  }

  const positions = list.flatMap(positionsOf);

  // Duplicates are the norm — a collared animal reports the same spot for
  // hours — and they add nothing to a hull while degrading the triangulation.
  const unique = [];
  const seen = new Set();
  for (const [lng, lat] of positions) {
    const key = `${lng},${lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([lng, lat]);
  }

  if (unique.length < 3) return null;

  const meanLat = unique.reduce((n, p) => n + p[1], 0) / unique.length;
  const scale = Math.cos((meanLat * Math.PI) / 180) || 1;
  const planar = unique.map(([lng, lat]) => [lng * scale, lat]);

  const hull = hullType === "concave" ? concaveHull(planar, alpha) : convexHull(planar);
  if (!hull || hull.length < 3) return null;

  // Back to degrees, then wound as asked and closed as GeoJSON requires.
  const ring = (signedArea(hull) < 0) === (winding === "cw") ? hull : [...hull].reverse();
  const coordinates = ring.map(([x, y]) => [x / scale, y]);
  coordinates.push(coordinates[0]);

  const geometry = { type: "Polygon", coordinates: [coordinates] };
  const properties = { ...(opts.properties ?? {}) };

  // A GeoJSON Point rather than a bare pair: it is the shape `bold:GeoPoint`
  // describes, so it can be read, stored, or drawn without unpacking. Both of
  // these sit outside `bold:rangeDiagnostics` and ignore `diagnostics: false` —
  // diagnostics record how the shape was built, while these describe what it
  // was built from, and callers want them without opting into provenance.
  properties.centroid = { type: "Point", coordinates: meanPosition(positions) };
  properties.count = positions.length;

  if (opts.diagnostics !== false) {
    properties["bold:rangeDiagnostics"] = {
      inputs: list.length,
      positions: positions.length,
      distinctPositions: unique.length,
      hullType,
      alpha: hullType === "concave" ? alpha : null,
      winding,
      vertices: coordinates.length,
      areaKm2: Number((geoArea(geometry) / 1e6).toFixed(2))
    };
  }

  return { type: "Feature", properties, geometry };
}
