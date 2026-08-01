/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Areal set operations on GeoJSON — currently union ("merge"), used to build a
 * region from its parts: IDNR regions from counties, or the State of Illinois
 * from all 102 of them.
 *
 * Pure geometry: no Mongo, no Meteor, no node built-ins. The instance-bound
 * wrapper that turns resources into depictions is `GeoApi#mergeShapes`.
 */

import polygonClipping from "polygon-clipping";

/**
 * Authalic Earth radius — the sphere with the same surface area as the WGS84
 * ellipsoid. This, not the equatorial radius (6378137), is the right constant
 * for area: the equatorial one runs ~0.22% high. Matches @turf/area, so figures
 * here agree with the rest of the GeoJSON ecosystem.
 */
const EARTH_RADIUS = 6371008.8;

/** Interior rings smaller than this (m²) are digitisation slivers, not enclaves. */
export const DEFAULT_MIN_HOLE_AREA = 100_000; // 0.1 km²

/** The only geometry types a union can consume. */
const AREAL_TYPES = new Set(["Polygon", "MultiPolygon"]);

/**
 * Ring winding conventions, which two standards disagree about.
 *
 * RFC 7946 wants exterior rings counterclockwise. d3-geo wants the opposite,
 * and reads a counterclockwise exterior as *the whole sphere minus* the
 * polygon — so a shape in the wrong convention renders as its own complement
 * rather than failing visibly. The Illinois county data is `cw`, as is
 * anything else BOLD draws through `GeoShapePlugin`.
 *
 * polygon-clipping normalises its output to `ccw` whatever it was handed, so
 * a union of `cw` shapes comes back inside-out. `mergeShapes` therefore
 * restores the convention it was given; see the `winding` option.
 */
export const WINDINGS = ["match", "ccw", "cw"];

const toRadians = (deg) => (deg * Math.PI) / 180;

/**
 * Spherical area of one linear ring, signed by winding direction.
 *
 * Standard spherical-excess sum over consecutive vertex triples; the same
 * formula GeoJSON area implementations use. Sign carries the winding, which is
 * how interior rings subtract from their exterior.
 *
 * @param {Array<[number, number]>} ring - [lng, lat] positions
 * @returns {number} signed area in square metres
 * @private
 */
function ringArea(ring) {
  const n = ring?.length ?? 0;
  if (n < 3) return 0;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = ring[i];
    const middle = ring[(i + 1) % n];
    const upper = ring[(i + 2) % n];
    total += (toRadians(upper[0]) - toRadians(lower[0])) * Math.sin(toRadians(middle[1]));
  }
  return (total * EARTH_RADIUS * EARTH_RADIUS) / 2;
}

/**
 * Area of any GeoJSON object in square metres.
 *
 * Non-areal geometry contributes nothing, so a mixed FeatureCollection measures
 * only its polygons. Interior rings subtract.
 *
 * @param {object} geo - any GeoJSON object
 * @returns {number} area in square metres, never negative
 */
export function geoArea(geo) {
  if (!geo) return 0;
  if (geo.type === "FeatureCollection") return (geo.features ?? []).reduce((n, f) => n + geoArea(f), 0);
  if (geo.type === "Feature") return geoArea(geo.geometry);
  if (geo.type === "GeometryCollection") return (geo.geometries ?? []).reduce((n, g) => n + geoArea(g), 0);
  if (geo.type === "Polygon") {
    return Math.abs((geo.coordinates ?? []).reduce((n, ring, i) =>
      n + (i === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring))), 0));
  }
  if (geo.type === "MultiPolygon") {
    return (geo.coordinates ?? []).reduce((n, poly) =>
      n + geoArea({ type: "Polygon", coordinates: poly }), 0);
  }
  return 0;
}

/**
 * Collect every areal geometry inside a GeoJSON object as MultiPolygon
 * coordinate arrays — the shape polygon-clipping expects.
 *
 * @param {object} geo - any GeoJSON object
 * @returns {Array} array of MultiPolygon coordinate arrays
 * @private
 */
function arealParts(geo) {
  if (!geo) return [];
  if (geo.type === "FeatureCollection") return (geo.features ?? []).flatMap(arealParts);
  if (geo.type === "Feature") return arealParts(geo.geometry);
  if (geo.type === "GeometryCollection") return (geo.geometries ?? []).flatMap(arealParts);
  if (geo.type === "Polygon") return [[geo.coordinates]];
  if (geo.type === "MultiPolygon") return [geo.coordinates];
  return [];
}

/**
 * Winding of one ring, read off the sign of its spherical area: the
 * spherical-excess sum comes out negative for a counterclockwise ring.
 *
 * @param {Array<[number, number]>} ring
 * @returns {"ccw"|"cw"}
 * @private
 */
function ringWinding(ring) {
  return ringArea(ring) < 0 ? "ccw" : "cw";
}

/** True when a GeoJSON object contains no areal geometry at all. */
function hasNoArea(geo) {
  if (!geo) return true;
  if (AREAL_TYPES.has(geo.type)) return false;
  return arealParts(geo).length === 0;
}

/**
 * Merge GeoJSON shapes into a single Feature covering their union.
 *
 * Interior borders dissolve, so merging the 102 Illinois counties yields the
 * outline of the state rather than a stack of county rings.
 *
 * **Slivers.** Shapes drawn from one source share exact vertices and union
 * cleanly. Shapes from *different* sources disagree — they are different
 * generalisations of the same border — and leave a rash of tiny interior rings.
 * Rings under `minHoleArea` are dropped and counted in `holesDropped`. Snapping
 * coordinates to a grid, the intuitive alternative, makes this worse rather
 * than better; see `.private/specs/ontologize/ontologize-geo-spec.md`.
 *
 * Non-areal geometry (points, lines) is skipped rather than rejected, since a
 * mixed resource set is normal; the count lands in `skippedNonAreal`.
 *
 * **Winding.** The result is wound the way the input was, so a union of
 * shapes that render correctly renders correctly. This is not cosmetic: see
 * {@link WINDINGS} — the wrong convention draws the complement of the region
 * rather than nothing, which is easy to miss.
 *
 * @param {Array<object>} shapes - GeoJSON objects: geometries, Features,
 *   FeatureCollections, or GeometryCollections, in any mix
 * @param {object} [opts]
 * @param {object} [opts.properties] - properties for the resulting Feature
 * @param {number} [opts.minHoleArea=100000] - m²; interior rings below this are
 *   dropped as slivers. Pass 0 to keep every ring.
 * @param {"match"|"ccw"|"cw"} [opts.winding="match"] - exterior-ring winding of
 *   the result: as the first input was wound, RFC 7946 (`ccw`), or d3-geo
 *   (`cw`). Interior rings always wind opposite the exterior.
 * @param {boolean} [opts.diagnostics=true] - attach `bold:mergeDiagnostics`
 * @returns {object|null} a GeoJSON Feature, or null if nothing areal was given
 * @throws {Error} if `winding` is not one of {@link WINDINGS}
 */
export function mergeShapes(shapes, opts = {}) {
  const list = Array.isArray(shapes) ? shapes : [];
  const minHoleArea = opts.minHoleArea ?? DEFAULT_MIN_HOLE_AREA;
  const wanted = opts.winding ?? "match";
  if (!WINDINGS.includes(wanted)) {
    throw new Error(`mergeShapes: unknown winding "${wanted}" — expected one of ${WINDINGS.join(", ")}`);
  }

  const parts = list.flatMap(arealParts);
  if (parts.length === 0) return null;

  const skippedNonAreal = list.filter(hasNoArea).length;

  // Read the input convention before unioning: polygon-clipping discards it.
  const winding = wanted === "match" ? ringWinding(parts[0][0][0]) : wanted;

  // polygon-clipping treats its inputs as read-only, and every array it returns
  // is freshly built, so the caller's geometry is never touched.
  let merged = polygonClipping.union(parts[0], ...parts.slice(1));

  let holesDropped = 0;
  if (minHoleArea > 0) {
    merged = merged.map((poly) => {
      const kept = poly.slice(1).filter((ring) => {
        const keep = Math.abs(ringArea(ring)) >= minHoleArea;
        if (!keep) holesDropped++;
        return keep;
      });
      return [poly[0], ...kept];
    });
  }

  // polygon-clipping always returns counterclockwise exteriors; flip every ring
  // when the caller wants the other convention. Reversing preserves the
  // exterior/interior opposition, so holes stay holes.
  if (winding === "cw") merged = merged.map((poly) => poly.map((ring) => [...ring].reverse()));

  const geometry = merged.length === 1
    ? { type: "Polygon", coordinates: merged[0] }
    : { type: "MultiPolygon", coordinates: merged };

  const properties = { ...(opts.properties ?? {}) };
  if (opts.diagnostics !== false) {
    properties["bold:mergeDiagnostics"] = {
      inputs: list.length,
      skippedNonAreal,
      outerRings: merged.length,
      holes: merged.reduce((n, poly) => n + poly.length - 1, 0),
      holesDropped,
      winding,
      contiguous: merged.length === 1,
      areaKm2: Number((geoArea(geometry) / 1e6).toFixed(2)),
      vertices: merged.flat().reduce((n, ring) => n + ring.length, 0)
    };
  }

  return { type: "Feature", properties, geometry };
}
