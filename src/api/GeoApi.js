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

/**
 * `ontologize.geo` — instance-bound geospatial helpers: derive GeoJSON from a
 * resource's location properties, and look up solar events.
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
   * Get the geospatial location for a resource as a GeoJSON object.
   *
   * Checks for location data in this order of preference:
   * 1. `geo:lat` and `geo:long` properties - returns a GeoPoint
   * 2. Any property with `rdfs:range` of `bold:GeoPoint`
   * 3. Any property with `rdfs:range` of `bold:GeoJSON`
   *
   * @param {object} resource - The resource to get location for
   * @param {object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups
   * @returns {Promise<object|null>} GeoJSON Feature, or null if no location found
   */
  async getGeoJSON(resource, opts = {}) {
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
