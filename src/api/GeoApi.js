/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check } from "../lib/check.js";
import { getSunriseSunsetInfo } from "sunrise-sunset-api";
import { ApiNamespace } from "./ApiNamespace.js";
import { mergeShapes } from "../geo/merge.js";
import { getSpatialRange } from "../geo/range.js";

/**
 * `ontologize.geo` — instance-bound geospatial helpers: derive a resource's
 * spatial depiction as GeoJSON, and look up solar events.
 *
 * The pure, instance-free viewport/H3/geohash helpers used by the GeoView
 * cell-cache (`bboxToH3Cells`, `bufferRing`, `zoomToH3Resolution`, …) live in
 * `../geo/` and are exported from the `ontologize/geo` subpath. They are
 * re-exported at the bottom of this file for convenience so callers holding an
 * Ontologize instance can reach them without a second import; nothing about the
 * `ontologize/geo` / `ontologize/geo-server` subpaths changes.
 */
export class GeoApi extends ApiNamespace {
  /**
   * Get sunrise and sunset times for a location and date.
   *
   * Uses the sunrise-sunset.org API to get solar event times.
   *
   * @param {number[]} longLat - Array of [longitude, latitude]
   * @param {Date|string|number|object} date - The date (accepts same formats as formatDate)
   * @param {object} [opts] - Options (reserved for future use)
   * @returns {Promise<object>} Sunrise/sunset info with ISO date strings
   * @throws {Error} If the API call fails or parameters are invalid
   */
  async getSunriseSunset(longLat, date, opts = {}) {
    // Validate longLat
    if (!Array.isArray(longLat) || longLat.length !== 2) {
      throw new Error("longLat must be an array of [longitude, latitude]");
    }
    const [longitude, latitude] = longLat;
    if (typeof longitude !== "number" || typeof latitude !== "number") {
      throw new Error("longitude and latitude must be numbers");
    }
    opts.formatted = opts.formatted === true;

    // Extract the date value (same logic as formatDate)
    let dateValue = date;
    if (typeof date === "object" && date !== null && !(date instanceof Date)) {
      if (date["@value"] !== undefined) {
        dateValue = date["@value"];
      }
    }

    // Convert to Date object
    let dateObj;
    if (dateValue instanceof Date) {
      dateObj = dateValue;
    }
    else if (typeof dateValue === "string" || typeof dateValue === "number") {
      dateObj = new Date(dateValue);
    }
    else {
      throw new Error("Invalid date value");
    }

    if (isNaN(dateObj.getTime())) {
      throw new Error("Invalid date value");
    }

    // Format date as YYYY-MM-DD for the API
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    const dateString = `${year}-${month}-${day}`;

    // Call the sunrise-sunset API
    const response = await getSunriseSunsetInfo({
      latitude,
      longitude,
      date: dateString,
      formatted: opts.formatted
    });

    return response;
  }

  /**
   * Get the spatial depiction of a resource as GeoJSON.
   *
   * Checks for spatial data in this order of preference:
   * 1. `geo:lat` and `geo:long` properties — synthesises a `Point` geometry
   * 2. Any property with `rdfs:range` of `bold:GeoPoint`
   * 3. Any property with `rdfs:range` of `bold:GeoJSON` (e.g. `bold:spatialDepiction`)
   *
   * **The contract is a GeoJSON *object*, not specifically a Feature.** A
   * depiction legitimately arrives as any of the GeoJSON object types:
   * pattern 1 synthesises a bare `Point` geometry, while patterns 2 and 3 hand
   * back whatever the property holds — commonly a `Feature` (as
   * `bold:spatialDepiction` does for `gov:County`), but equally a `Geometry`,
   * `FeatureCollection`, or `GeometryCollection`. Narrowing the return to
   * `Feature` would mean inventing a wrapper for geometries and choosing how to
   * collapse a `FeatureCollection`, so the union is deliberate.
   *
   * Callers branch on `type` and wrap a bare geometry when they need a Feature —
   * see `ResourceGeoView`'s `isGeoJSONGeometry` branch. A multi-valued property
   * yields its first value.
   *
   * @param {object} resource - The resource to get the depiction for
   * @param {object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups
   * @returns {Promise<object|null>} A GeoJSON object — Feature, FeatureCollection,
   *   Geometry, or GeometryCollection — or null if the resource has no spatial data
   */
  async getSpatialDepiction(resource, opts = {}) {
    check(resource, Object);
    const cache = opts.ontologyCache;

    // Pattern 1: Check for geo:lat and geo:long properties
    const lat = this._extractNumericValue(resource["geo:lat"]);
    const lng = this._extractNumericValue(resource["geo:long"]);

    if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
      return {
        type: "Point",
        coordinates: [lng, lat]  // GeoJSON uses [lng, lat] order
      };
    }

    // Pattern 2 & 3: Check for properties with rdfs:range of bold:GeoPoint or bold:GeoJSON
    // We need to scan resource properties and look up their ontology definitions
    for (const propertyName of Object.keys(resource)) {
      // Skip special properties
      if (propertyName.startsWith("@") || propertyName === "_id") {
        continue;
      }

      const propertyValue = resource[propertyName];
      if (propertyValue === null || propertyValue === undefined) {
        continue;
      }

      // Look up property definition in ontology
      const propertyDef = await this.ontologize._cachedOntologyLookup(propertyName, cache);
      if (!propertyDef) {
        continue;
      }

      const range = propertyDef["rdfs:range"];
      if (!range) {
        continue;
      }

      // Handle range as string or object with @id
      const rangeValue = typeof range === "object" ? (range["@id"] || range._id) : range;

      // Pattern 2: bold:GeoPoint
      if (rangeValue === "bold:GeoPoint") {
        const geoPoint = this._parseGeoValue(propertyValue);
        if (geoPoint) {
          return geoPoint;
        }
      }

      // Pattern 3: bold:GeoJSON
      if (rangeValue === "bold:GeoJSON") {
        const geoJson = this._parseGeoValue(propertyValue);
        if (geoJson) {
          return geoJson;
        }
      }
    }

    // No location found
    return null;
  }

  /**
   * Merge several resources' spatial depictions into one Feature covering their
   * union — an IDNR region from its counties, or Illinois from all 102 of them.
   * Interior borders dissolve.
   *
   * Each resource contributes one depiction: the first, or whichever
   * `opts.select` picks. Resources whose depiction is non-areal (a point, a
   * line) are skipped rather than rejected, and ids that resolve to nothing are
   * counted — both land in `properties["bold:mergeDiagnostics"]` along with
   * `holesDropped`, which is the signal that the inputs disagreed. Callers
   * building a region should assert `holesDropped === 0 && contiguous`.
   *
   * See `.private/specs/ontologize/ontologize-geo-spec.md` for why sliver holes
   * appear (mixed provenance, not imprecision) and why snapping does not fix them.
   *
   * Like `getSpatialDepiction`, this needs the ontology loaded: a depiction is
   * only recognised once its property's `rdfs:range` is known to be
   * `bold:GeoJSON` / `bold:GeoPoint`. Against an empty Ontology collection every
   * resource resolves to nothing and the result is null.
   *
   * @param {Array<string|object>|string|object} resources - resource ids or
   *   resources, or a single one of either
   * @param {object} [opts]
   * @param {object} [opts.properties] - properties for the resulting Feature
   * @param {number} [opts.minHoleArea=100000] - m²; interior rings below this
   *   are dropped as slivers. Pass 0 to keep every ring.
   * @param {function} [opts.select] - `(depictions, resource) => depiction`,
   *   for resources carrying more than one depiction
   * @param {boolean} [opts.diagnostics=true] - attach `bold:mergeDiagnostics`
   * @param {Map} [opts.ontologyCache] - cache Map for ontology lookups
   * @returns {Promise<object|null>} a GeoJSON Feature, or null if nothing areal
   *   could be resolved
   */
  async mergeShapes(resources, opts = {}) {
    const list = Array.isArray(resources) ? resources : (resources ? [resources] : []);
    const shapes = [];
    let unresolved = 0;

    for (const entry of list) {
      let resource = entry;
      if (typeof entry === "string") {
        const found = await this.ontologize.getResourceForId(entry);
        resource = found?.resource ?? null;
      }
      if (!resource) {
        unresolved++;
        continue;
      }

      let shape;
      if (opts.select) {
        // An LD proxy collapses a multi-valued property to its first value, so
        // reach through __raw to offer the selector every depiction.
        const raw = resource.__raw?.["bold:spatialDepiction"] ?? resource["bold:spatialDepiction"];
        const depictions = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        shape = opts.select(depictions, resource);
      }
      else {
        shape = await this.getSpatialDepiction(resource, opts);
      }

      if (shape) shapes.push(shape);
      else unresolved++;
    }

    const merged = mergeShapes(shapes, opts);
    if (merged && opts.diagnostics !== false) {
      merged.properties["bold:mergeDiagnostics"].requested = list.length;
      merged.properties["bold:mergeDiagnostics"].unresolved = unresolved;
    }
    return merged;
  }

  /**
   * The hull enclosing several resources' spatial data — an animal's home range
   * from its tracking reports, suitable for storing as `bold:spatialRange`.
   *
   * Where `mergeShapes` unions areas, this reads *positions*: a mix of points,
   * lines and polygons is ordinary input, and every vertex counts the same.
   * Resources contributing no position are counted as `unresolved` rather than
   * rejected, so one bad id shrinks the range visibly instead of silently.
   *
   * `hullType: "concave"` uses the same alpha-shape rule as
   * `imports/lib/hullUtils.js`, so a stored range agrees with the hull
   * `RangeExtentPlugin` draws live for the same points.
   *
   * Like `getSpatialDepiction`, this needs the ontology loaded: a depiction is
   * only recognised once its property's `rdfs:range` is known to be
   * `bold:GeoJSON` / `bold:GeoPoint`. Against an empty Ontology collection every
   * resource resolves to nothing and the result is null.
   *
   * @param {Array<string|object>|string|object} resources - resource ids or
   *   resources, or a single one of either
   * @param {object} [opts]
   * @param {object} [opts.properties] - properties for the resulting Feature
   * @param {"convex"|"concave"} [opts.hullType="convex"] - boundary shape
   * @param {number} [opts.alpha=0.5] - concavity, 0…1; `concave` only
   * @param {"cw"|"ccw"} [opts.winding="cw"] - exterior-ring winding; defaults to
   *   the d3-geo / `2dsphere` convention the rest of BOLD uses
   * @param {function} [opts.select] - `(depictions, resource) => depiction`,
   *   for resources carrying more than one depiction
   * @param {boolean} [opts.diagnostics=true] - attach `bold:rangeDiagnostics`
   * @param {Map} [opts.ontologyCache] - cache Map for ontology lookups
   * @returns {Promise<object|null>} a GeoJSON Feature, or null if fewer than 3
   *   distinct positions could be resolved
   */
  async getSpatialRange(resources, opts = {}) {
    const list = Array.isArray(resources) ? resources : (resources ? [resources] : []);
    const shapes = [];
    let unresolved = 0;

    for (const entry of list) {
      let resource = entry;
      if (typeof entry === "string") {
        const found = await this.ontologize.getResourceForId(entry);
        resource = found?.resource ?? null;
      }
      if (!resource) {
        unresolved++;
        continue;
      }

      let shape;
      if (opts.select) {
        // An LD proxy collapses a multi-valued property to its first value, so
        // reach through __raw to offer the selector every depiction.
        const raw = resource.__raw?.["bold:spatialDepiction"] ?? resource["bold:spatialDepiction"];
        const depictions = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        shape = opts.select(depictions, resource);
      }
      else {
        shape = await this.getSpatialDepiction(resource, opts);
      }

      if (shape) shapes.push(shape);
      else unresolved++;
    }

    const range = getSpatialRange(shapes, opts);
    if (range && opts.diagnostics !== false) {
      range.properties["bold:rangeDiagnostics"].requested = list.length;
      range.properties["bold:rangeDiagnostics"].unresolved = unresolved;
    }
    return range;
  }

  /**
   * @deprecated Use {@link GeoApi#getSpatialDepiction}. Kept as a delegate so
   *   downstream consumers keep working; scheduled for removal once they migrate.
   *
   * @param {object} resource - The resource to get the depiction for
   * @param {object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups
   * @returns {Promise<object|null>} See {@link GeoApi#getSpatialDepiction}
   */
  async getGeoJSON(resource, opts = {}) {
    return this.getSpatialDepiction(resource, opts);
  }

  /**
   * Extract a numeric value from a property value (handles JSON-LD @value wrapper)
   *
   * @param {*} value - The value to extract from
   * @returns {number|null} The numeric value or null
   * @private
   */
  _extractNumericValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "object" && value["@value"] !== undefined) {
      return parseFloat(value["@value"]);
    }
    if (typeof value === "string") {
      const num = parseFloat(value);
      return isNaN(num) ? null : num;
    }
    // Handle arrays - take first value
    if (Array.isArray(value) && value.length > 0) {
      return this._extractNumericValue(value[0]);
    }
    return null;
  }

  /**
   * Parse a property value as GeoJSON
   *
   * @param {*} value - The value to parse
   * @returns {object|null} GeoJSON object or null
   * @private
   */
  _parseGeoValue(value) {
    if (!value) return null;

    // Handle arrays - take first value
    if (Array.isArray(value)) {
      return this._parseGeoValue(value[0]);
    }

    // Direct GeoJSON object (has type and coordinates/geometries/geometry)
    if (typeof value === "object" && value.type && (value.coordinates || value.geometries || value.geometry || value.features)) {
      return value;
    }

    // JSON-LD wrapped value
    if (typeof value === "object" && value["@value"] !== undefined) {
      const innerValue = value["@value"];
      if (typeof innerValue === "string") {
        try {
          return JSON.parse(innerValue);
        }
        catch (e) {
          return null;
        }
      }
      if (typeof innerValue === "object" && innerValue.type) {
        return innerValue;
      }
    }

    // String that might be JSON
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && parsed.type) {
          return parsed;
        }
      }
      catch (e) {
        return null;
      }
    }

    return null;
  }
}

// Convenience re-exports of the pure geo helpers (also available directly from
// the `ontologize/geo` subpath). These are instance-free and unrelated to the
// GeoApi instance methods above.
export * from "../geo/index.js";

export default GeoApi;
