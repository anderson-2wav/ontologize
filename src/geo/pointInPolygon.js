/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 */

/**
 * Ray-casting point-in-polygon for GeoJSON geometries. Pure — no Mongo, no
 * Meteor, no node built-ins — so it is safe to import from client code through
 * the `ontologize/geo` sub-path.
 *
 * Every point is `[lng, lat]`, matching GeoJSON. Callers holding `[lat, lng]`
 * (h3-js `cellToLatLng`, browser Geolocation) must swap before calling.
 */

/**
 * Whether a point falls inside a single linear ring.
 *
 * @param {[number, number]} point - [lng, lat]
 * @param {Array<[number, number]>} ring - linear ring, closed or open
 * @returns {boolean}
 */
export function pointInRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = (yi > y) !== (yj > y);
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether a point falls inside a GeoJSON Polygon's coordinates: inside the
 * outer ring and outside every hole.
 *
 * @param {[number, number]} point - [lng, lat]
 * @param {Array<Array<[number, number]>>} rings - ring 0 outer, rings 1+ holes
 * @returns {boolean}
 */
export function pointInPolygon(point, rings) {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  if (!pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

/**
 * Whether a point falls inside a Polygon, a MultiPolygon, or a Feature
 * wrapping either. Anything else — a Point, a missing geometry, a malformed
 * coordinates array — is false rather than a throw: one unusable region
 * geometry must not fail a whole roster request.
 *
 * @param {[number, number]} point - [lng, lat]
 * @param {object} geometry
 * @returns {boolean}
 */
export function pointInGeometry(point, geometry) {
  const g = geometry?.type === "Feature" ? geometry.geometry : geometry;
  if (!g || !Array.isArray(g.coordinates)) return false;
  if (g.type === "Polygon") return pointInPolygon(point, g.coordinates);
  if (g.type === "MultiPolygon") {
    return g.coordinates.some(rings => pointInPolygon(point, rings));
  }
  return false;
}

/**
 * Bounding box of a GeoJSON Polygon, MultiPolygon, or a Feature wrapping
 * either, as `[minLng, minLat, maxLng, maxLat]`.
 *
 * Lives beside `pointInGeometry` because that is what it is for: a ray cast
 * over a 218-vertex ring is cheap, but a scan over 50 of them is not, and one
 * bbox comparison rejects 49 of the 50 before the cast. Callers that keep the
 * geometry around should keep the box too rather than recomputing it.
 *
 * Only ring 0 of each polygon is walked. Holes are by definition inside the
 * outer ring, so they cannot widen the box.
 *
 * Anything unusable — a Point, a missing geometry, a malformed coordinates
 * array — is null rather than a throw, matching `pointInGeometry`: one broken
 * shape must not fail a whole scan.
 *
 * @param {object} shape - a GeoJSON Feature or geometry
 * @returns {[number, number, number, number]|null}
 */
export function geometryBbox(shape) {
  const g = shape?.type === "Feature" ? shape.geometry : shape;
  if (!g || !Array.isArray(g.coordinates)) return null;

  const polygons = g.type === "Polygon"
    ? [g.coordinates]
    : (g.type === "MultiPolygon" ? g.coordinates : null);
  if (!polygons) return null;

  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const rings of polygons) {
    for (const position of rings?.[0] ?? []) {
      const [lng, lat] = position ?? [];
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return Number.isFinite(minLng) && Number.isFinite(minLat)
    ? [minLng, minLat, maxLng, maxLat]
    : null;
}

/**
 * Whether a point falls inside a bounding box, edges included.
 *
 * @param {[number, number]} point - [lng, lat]
 * @param {[number, number, number, number]} bbox - [minLng, minLat, maxLng, maxLat]
 * @returns {boolean}
 */
export function pointInBbox([lng, lat], bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}
