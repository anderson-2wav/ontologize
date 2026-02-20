/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
 */

import { check, Match } from "./lib/check.js";
import _ from "lodash";
import jsonPath from "./lib/jsonpath.js";
import LD from "bold-ld";
import { format } from "date-fns";
import { TZDate, tzName } from "@date-fns/tz";
import { getSunriseSunsetInfo } from "sunrise-sunset-api";
import {Query} from "./Query.js";

/**
 * Ontologize - Utilities for working with ontology data in JSON-LD format
 *
 * This module provides client/server safe functions for ontology processing.
 * Server-only functions are available via "ontologize/server" import.
 *
 * @class
 */
export class Ontologize {
  // Default properties for getLabel (in order of preference)
  static DEFAULT_LABEL_PROPERTIES = ["dcterms:title", "foaf:name", "rdfs:label"];

  // Default properties for getDescription (in order of preference)
  static DEFAULT_DESCRIPTION_PROPERTIES = ["dcterms:description", "rdfs:comment"];

  // Singleton instance
  static _instance = null;

  /**
   * Initialize the singleton Ontologize instance.
   * Must be called before using get().
   *
   * @param {object} ontologyCollection - Collection adapter or raw MongoDB collection
   * @param {object} contextCollection - Collection adapter or raw MongoDB collection
   * @param {object} statementsCollection - Collection adapter or raw MongoDB collection for Statements
   * @param {object} [opts] - Configuration options (same as constructor)
   * @returns {Ontologize} The initialized singleton instance
   */
  static initialize(ontologyCollection, contextCollection, statementsCollection, opts = {}) {
    Ontologize._instance = new Ontologize(ontologyCollection, contextCollection, statementsCollection, opts);
    return Ontologize._instance;
  }

  /**
   * Get the singleton Ontologize instance.
   * Throws an error if initialize() has not been called.
   *
   * @returns {Ontologize} The singleton instance
   * @throws {Error} If initialize() has not been called
   */
  static get() {
    if (!Ontologize._instance) {
      throw new Error("Ontologize has not been initialized. Call Ontologize.initialize() first.");
    }
    return Ontologize._instance;
  }

  /**
   * Create a new Ontologize instance
   *
   * @param {object} ontologyCollection - Collection adapter or raw MongoDB collection
   * @param {object} contextCollection - Collection adapter or raw MongoDB collection
   * @param {object} statementsCollection - Collection adapter or raw MongoDB collection for Statements
   * @param {object} [opts] - Configuration options
   * @param {object} [opts.collections] - named collections in addition to ontology, context, and statements
   * @param {object} [opts.context] - Default JSON-LD context
   * @param {boolean} [opts.debug=false] - Enable debug logging
   * @param {string[]} [opts.labelProperties] - Properties to check for labels (in order of preference)
   * @param {string[]} [opts.descriptionProperties] - Properties to check for descriptions (in order of preference)
   * @param {string} [opts.dateFormat="M/d/yyyy"] - Default format for dates
   * @param {string} [opts.dateTimeFormat="M/d/yyyy h:mm a"] - Default format for date-times
   * @param {string} [opts.dateTimeZone="America/Los_Angeles"] - Default timezone for date formatting
   * @param {object} [opts.idResolvers] - hints to resolve ids to collections for special cases other than namespaces
   * @param {boolean} [opts.proxy=true] - prefer LD Proxies
   */
  constructor(ontologyCollection, contextCollection, statementsCollection, opts = {}) {
    check(ontologyCollection, Object);
    check(contextCollection, Object);
    check(statementsCollection, Object);

    this.collections = {
      ontology: ontologyCollection,
      context: contextCollection,
      statements: statementsCollection
    };

    this.opts = opts;
    this.opts.defaultContext = this.opts.defaultContext || Ontologize.DEFAULT_CONTEXT;
    this.opts.debug = this.opts.debug || false;
    this.opts.labelProperties = this.opts.labelProperties || Ontologize.DEFAULT_LABEL_PROPERTIES;
    this.opts.descriptionProperties = this.opts.descriptionProperties || Ontologize.DEFAULT_DESCRIPTION_PROPERTIES;
    this.opts.dateFormat = this.opts.dateFormat || "M/d/yyyy";
    this.opts.dateTimeFormat = this.opts.dateTimeFormat || "M/d/yyyy h:mm a ZZ";
    this.opts.dateTimeZone = this.opts.dateTimeZone || "America/Los_Angeles";
    if (this.opts.collections) {
      Object.assign(this.collections, this.opts.collections);
    }
    this.opts.proxy = this.opts.proxy !== false;
    this.version = "0.1.0";

    // Initialize singleton LD instance for this Ontologize instance
    this._ld = null;
    // TODO THERE WERE CLIENT/SERVER PROBLEMS HERE...
    // that derive from using Meteor collections instead of MeteorCollectionAdapter
    // if we're doing it the right way I don't think this promise stuff is needed any more
    const wat = this.collections.context.findOne({ _id: "@id" });
    if (wat instanceof Promise) {
      wat.then((context) => {
        const ld = new LD({
          context,
          proxy: this.opts.proxy,
          sortTypesFn: this.sortTypesFn.bind(this)
        });
        this._ld = ld;
      });
    }
    else if (wat) {
      const ld = new LD({
        context,
        proxy: this.opts.proxy,
        sortTypesFn: this.sortTypesFn.bind(this)
      });
      this._ld = ld;
    }
  }

  /**
   * Get the singleton LD instance for this Ontologize instance.
   * Creates the instance on first access.
   *
   * @returns {LD} The LD instance
   */
  ld() {
    if (!this._ld) {
      // this is a problem if it happens because there is no context
      this._ld = new LD();
    }
    return this._ld;
  }

  /**
   * Lookup an ontology resource by _id, using cache if provided.
   * This helper reduces repeated Ontology.findOne() calls when processing
   * multiple resources that reference the same ontology classes/properties.
   *
   * @param {string} id - The _id of the ontology resource to lookup
   * @param {Map} [cache] - Optional Map to cache lookups (key: _id, value: resource or null)
   * @returns {Promise<Object|null>} The proxied ontology resource, or null if not found
   * @private
   */
  async _cachedOntologyLookup(id, cache) {
    if (!id) return null;

    // Check cache first
    if (cache && cache.has(id)) {
      // console.log(`Using cached ${id}`);
      return cache.get(id);
    }

    // Perform lookup
    const raw = await this.collections.ontology.findOne({ _id: id });
    const resource = raw ? this.ld().proxy(raw) : null;

    // Store in cache (including null for not-found)
    if (cache) {
      cache.set(id, resource);
    }

    return resource;
  }

  /**
   * Validate that a resource is a valid ontology resource
   *
   * @param {object} resource - The resource to validate
   * @returns {boolean} True if valid ontology resource
   */
  isValidOntologyResource(resource) {
    check(resource, Object);

    // Must have @id
    if (!resource["@id"]) {
      return false;
    }

    // Must have @type
    if (!resource["@type"]) {
      return false;
    }

    return true;
  }

  /**
   * Determine if a resource is an RDF Statement resource
   *
   * Detection criteria:
   * - Resource has @type of rdf:Statement
   * - Resource has properties rdf:subject, rdf:predicate, rdf:object (implies Statement by domain)
   *
   * @param {object} resource - The resource to check
   * @returns {boolean} True if the resource is an RDF Statement
   */
  isStatementResource(resource) {
    check(resource, Object);

    // Check for explicit @type of rdf:Statement
    if (resource["@type"]) {
      const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];

      // Support both compacted and expanded forms
      const statementTypes = [
        "rdf:Statement",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement"
      ];

      if (types.some(type => statementTypes.includes(type))) {
        return true;
      }
    }

    // Check for rdf:subject, rdf:predicate, rdf:object properties
    // These properties have domain rdf:Statement, so their presence implies Statement
    const hasSubject = resource["rdf:subject"] !== undefined ||
      resource["http://www.w3.org/1999/02/22-rdf-syntax-ns#subject"] !== undefined;
    const hasPredicate = resource["rdf:predicate"] !== undefined ||
      resource["http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate"] !== undefined;
    const hasObject = resource["rdf:object"] !== undefined ||
      resource["http://www.w3.org/1999/02/22-rdf-syntax-ns#object"] !== undefined;

    // If resource has all three statement properties, it's a Statement
    return hasSubject && hasPredicate && hasObject;
  }

  /**
   * Get the label for a resource, or get the label for a property of a resource.
   * Checks the configured opts.labelProperties (default: dcterms:title, foaf:name, rdfs:label) in order of preference.
   * Label properties can be overridden by bui:schema.labelProperties on the resource's class.
   * Or property label can be absolutely set by bui:schema.properties._property_.label
   *
   * @param {object} resource - The resource
   * @param {string} [property]
   * @param {string|object} [fallbackOrOpts] - Fallback string if no label found, or opts object
   * @param {object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups (key: _id, value: resource)
   * @returns {Promise<string>} The label or fallback
   */
  async getLabel(resource, property, fallbackOrOpts, opts) {
    check(resource, Object);
    check(property, Match.Optional(String));

    if (this.opts.proxy && !this.ld().isProxy(resource)) {
      // TODO think about... ld.proxy(opt.proxyFlatten) is too invasive
      //it can break non-proxy objects in surprising ways,
      resource = this.ld().proxy(_.cloneDeep(resource));
    }
    // Handle flexible argument pattern: (resource, property, fallback) or (resource, property, opts)
    let fallback;
    if (typeof fallbackOrOpts === "object" && fallbackOrOpts !== null) {
      opts = fallbackOrOpts;
      fallback = undefined;
    }
    else {
      fallback = fallbackOrOpts;
    }
    opts = opts || {};
    const cache = opts.ontologyCache;

    check(fallback, Match.Optional(String));

    const labelProperties = this.opts.labelProperties;
    // Get the assembled schema to check for label or labelProperties override
    const schema = await this.getSchema(property, resource, opts);
    // if there is a direct label override, use it
    if (schema.label) {
      return schema.label;
    }
    if (schema.labelProperties) {
      labelProperties.unshift(...schema.labelProperties);
    }

    // which thing to examine, the resource or the property resource?
    let examineResource = resource;
    // if property was provided, then we want the property resource, not the resource
    if (property) {
      examineResource = await this._cachedOntologyLookup(property, cache);
    }

    if (examineResource) {
      // Check label properties in order of preference
      for (const prop of labelProperties) {
        if (examineResource[prop]) {
          if (this.ld().isProxy(examineResource)) {
            return examineResource[prop];
          }
          else {
            return Array.isArray(examineResource[prop]) ?
              examineResource[prop][0] :
              examineResource[prop];
          }
        }
      }
    }

    // if we got nothing, and its a property label we're looking for
    if (property) {
      return property;
    }

    const _id = resource._id ? "_id" : "@id";
    if (resource[_id]) {
      // find a type name
      let typeName;
      if (resource["@type"]?.[0]) {
        const found = await this.getResourceForId(resource["@type"][0]);
        if (found) {
          typeName = await this.getLabel(found.resource);
        }
      }
      // Try to extract a readable name from the ID
      const id = resource[_id];
      const parts = id.split(/[#/:]/);
      return (typeName ? `${typeName} ` : "") + parts[parts.length - 1];
    }

    return fallback || "Unknown";
  }

  /**
   * Get the label property for a resource, checking properties in order of preference.
   * Property order can be overridden by bui:schema.labelProperties on the resource's class,
   * otherwise uses opts.labelProperties (default: dcterms:title, foaf:name, rdfs:label)
   *
   * If no label property is found on the resource, then the last property of
   * ontologize.opts.labelProperties is returned, which is assumed to be the most generic.
   * It will be up to caller to handle that resource[prop] is undefined.
   *
   * @param {object} resource - The resource
   * @param {string} [fallback] - Fallback if no label found
   * @returns {Promise<string>} The label or fallback
   */
  async getLabelProperty(resource, fallback) {
    check(resource, Object);
    check(fallback, Match.Optional(String));

    // Get the assembled class schema to check for labelProperties override
    const classSchema = await this.getSchema(undefined, resource);
    const labelProperties = classSchema?.labelProperties || this.opts.labelProperties;

    // Check label properties in order of preference
    for (const prop of labelProperties) {
      if (resource[prop]) {
        return prop;
      }
    }

    return fallback || this.opts.labelProperties[this.opts.labelProperties - 1];
  }
  /**
   * Get the description for a resource, checking properties in order of preference.
   * Property order can be overridden by bui:schema.descriptionProperties on the resource's class,
   * otherwise uses opts.descriptionProperties (default: dcterms:description, rdfs:comment)
   *
   * @param {object} resource - The resource
   * @param {string} [fallback] - Fallback if no description found
   * @returns {Promise<string>} The description or fallback
   */
  async getDescription(resource, fallback) {
    check(resource, Object);
    check(fallback, Match.Optional(String));

    // Get the assembled class schema to check for descriptionProperties override
    const classSchema = await this.getSchema(undefined, resource);
    const descriptionProperties = classSchema?.descriptionProperties || this.opts.descriptionProperties;

    // Check description properties in order of preference
    for (const prop of descriptionProperties) {
      if (resource[prop]) {
        if (this.ld().isProxy(resource)) {
          return resource[prop];
        }
        else {
          return Array.isArray(resource[prop]) ?
            resource[prop][0] :
            resource[prop];
        }
      }
    }

    return fallback || "";
  }

  /**
   * Get the property name for the description of a resource, checking properties in order of preference.
   * Property order can be overridden by bui:schema.descriptionProperties on the resource's class,
   * otherwise uses opts.descriptionProperties (default: dcterms:description, rdfs:comment)
   *
   * If no description property is found on the resource, then the last property of
   * ontologize.opts.descriptionProperties is returned, which is assumed to be the most generic.
   * It will be up to caller to handle that resource[prop] is undefined.
   *
   * @param {object} resource - The resource
   * @param {string} [fallback] - Fallback if no description property found
   * @returns {Promise<string>} The description or fallback
   */
  async getDescriptionProperty(resource, fallback) {
    check(resource, Object);
    check(fallback, Match.Optional(String));

    // Get the assembled class schema to check for descriptionProperties override
    const classSchema = await this.getSchema(undefined, resource);
    const descriptionProperties = classSchema?.descriptionProperties || this.opts.descriptionProperties;

    // Check description properties in order of preference
    for (const prop of descriptionProperties) {
      if (resource[prop]) {
        return prop;
      }
    }
    // the last default descriptionProperties is the most generic
    return fallback || this.opts.descriptionProperties[this.opts.descriptionProperties.length - 1];
  }

  /**
   * Format a date value into a human-friendly string.
   *
   * Handles various input formats:
   * - Date objects
   * - ISO date strings
   * - Timestamps (numbers)
   * - JSON-LD typed literals with @value
   *
   * @param {Date|string|number|object} date - The date value to format
   * @param {object} [opts] - Options to override defaults
   * @param {string} [opts.dateFormat] - Format string for dates (default from constructor opts)
   * @param {string} [opts.dateTimeFormat] - Format string for date-times (default from constructor opts)
   * @param {string} [opts.dateTimeZone] - Timezone for formatting (default from constructor opts)
   * @param {boolean} [opts.includeTime=false] - Whether to include time in output
   * @returns {string} The formatted date string, or empty string if invalid
   */
  formatDate(date, opts = {}) {
    if (date === null || date === undefined) {
      return "";
    }

    // Merge options with defaults
    const dateFormat = opts.dateFormat || this.opts.dateFormat;
    const dateTimeFormat = opts.dateTimeFormat || this.opts.dateTimeFormat;
    const dateTimeZone = opts.dateTimeZone || this.opts.dateTimeZone;
    const includeTime = opts.includeTime || false;

    // Extract the actual date value
    let dateValue = date;

    // Handle JSON-LD typed literal with @value
    if (typeof date === "object" && date !== null && !(date instanceof Date)) {
      if (date["@value"] !== undefined) {
        dateValue = date["@value"];
      }
    }

    // Convert to Date object if needed
    let dateObj;
    if (dateValue instanceof Date) {
      dateObj = dateValue;
    }
    else if (typeof dateValue === "string" || typeof dateValue === "number") {
      dateObj = new Date(dateValue);
    }
    else {
      return "";
    }

    // Validate the date
    if (isNaN(dateObj.getTime())) {
      return "";
    }

    try {
      // Create a TZDate for timezone-aware formatting
      const tzDate = new TZDate(dateObj, dateTimeZone);
      let formatString = includeTime ? dateTimeFormat : dateFormat;

      // Handle custom ZZ format for timezone name
      let appendTzName = false;
      if (formatString.endsWith("ZZ")) {
        appendTzName = true;
        formatString = formatString.slice(0, -2).trim();
      }

      let result = format(tzDate, formatString);

      if (appendTzName) {
        const shortTzName = tzName(dateTimeZone, tzDate, "short");
        result = result + " " + shortTzName;
      }

      return result;
    }
    catch (error) {
      // Fallback to basic formatting without timezone
      try {
        let formatString = includeTime ? dateTimeFormat : dateFormat;
        // Strip ZZ in fallback as well
        if (formatString.endsWith("ZZ")) {
          formatString = formatString.slice(0, -2).trim();
        }
        return format(dateObj, formatString);
      }
      catch (e) {
        return "";
      }
    }
  }

  /**
   * Format a date value with time for display (shorthand for formatDate with includeTime: true)
   *
   * @param {Date|string|number|object} date - The date value to format
   * @param {object} [opts] - Options to override defaults (same as formatDate)
   * @returns {string} The formatted date-time string, or empty string if invalid
   */
  formatDateTime(date, opts = {}) {
    return this.formatDate(date, { ...opts, includeTime: true });
  }

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
      const propertyDef = await this._cachedOntologyLookup(propertyName, cache);
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

  /**
   * Get the label for a resource by looking it up from the ontology collection
   *
   * @param {string} resourceId - The resource ID to look up
   * @param {string} [fallback] - Fallback if no resource or label found
   * @returns {Promise<string>} The label or fallback
   */
  async getLabelFromId(resourceId, fallback) {
    check(resourceId, String);
    check(fallback, Match.Optional(String));

    try {
      // Look up the resource from the ontology collection
      const rawResource = await this.collections.ontology.findOne({ _id: resourceId });
      const resource = rawResource ? this.ld().proxy(rawResource) : null;

      if (resource) {
        // Use the getLabel method on the found resource
        return await this.getLabel(resource, fallback);
      }
    }
    catch (error) {
      console.warn(`Failed to lookup resource ${resourceId}: ${error.message}`);
    }

    // If lookup failed or resource not found, extract from ID as fallback
    const parts = resourceId.split(/[#/:]/);
    const extractedLabel = parts[parts.length - 1];

    return extractedLabel || fallback || "Unknown";
  }

  /**
   * Get context for compaction from provided context, Context collection, or default
   *
   * @param {object} [providedContext] - Optional context to use instead of collection/default
   * @returns {Promise<object>} Context object for JSON-LD operations
   */
  async getContext(providedContext = null) {
    // Use provided context if available
    if (providedContext) {
      return providedContext;
    }

    // Try to get context from Context collection
    try {
      const contextDoc = await this.collections.context.findOne({ _id: "@id" });
      if (contextDoc) {
        // Only use context from collection if it has meaningful data
        if (Object.keys(contextDoc).length > 0) {
          return contextDoc;
        }
      }
      return Ontologize.DEFAULT_CONTEXT;
    }
    catch (error) {
      console.warn(`Failed to load context from Context collection: ${error.message}`);
    }

    // Fall back to default ontology context
    return this.opts.defaultContext || Ontologize.DEFAULT_CONTEXT;
  }

  /**
   * Determine if a property should be treated as an array based on context and ontology information
   *
   * @param {string|object} property - The property ID (string) or resource object to check
   * @param {object} [opts] - Optional parameters
   * @param {object} [opts.context] - Current JSON-LD context to check
   * @param {boolean} [opts.cached=true] - Whether to use cached results
   * @returns {Promise<boolean>} True if property should be treated as an array
   */
  async isArrayProperty(property, opts = {}) {
    check(property, Match.OneOf(String, Object));
    check(opts, Match.Optional(Object));

    opts.cached = opts.cached !== false;

    let propertyId;
    let propertyResource = null;

    // Handle both string ID and resource object
    if (typeof property === "string") {
      propertyId = property;
      // Skip special properties
      if (propertyId === "__proto__" || propertyId.match(/^\d+$/)) {
        return false;
      }
    }
    else {
      // property is a resource object
      propertyResource = property;
      propertyId = property._id || property["@id"];
      if (!propertyId) {
        return false; // No valid ID found
      }
      // Skip special properties
      if (propertyId === "__proto__" || propertyId.match(/^\d+$/)) {
        return false;
      }
    }

    // Check current context for @container
    if (opts.context && opts.context[propertyId] && opts.context[propertyId]["@container"]) {
      const container = opts.context[propertyId]["@container"];
      return container === "@list" || container === "@set";
    }

    // Check global context
    try {
      const globalContext = await this.getContext();
      if (globalContext[propertyId] && globalContext[propertyId]["@container"]) {
        const container = globalContext[propertyId]["@container"];
        return container === "@list" || container === "@set";
      }
    }
    catch (error) {
      console.warn(`Failed to get global context: ${error.message}`);
    }

    // If we have the resource object directly, check it for bold:container
    if (propertyResource && propertyResource["bold:container"]) {
      const container = propertyResource["bold:container"];
      return container === "@list" || container === "@set";
    }

    // If we don't have the resource object, check ontology collection for bold:container property
    if (!propertyResource) {
      try {
        const rawResource = await this.collections.ontology.findOne({ _id: propertyId });
        const ontologyResource = rawResource ? this.ld().proxy(rawResource) : null;
        if (ontologyResource && ontologyResource["bold:container"]) {
          const container = ontologyResource["bold:container"];
          return container === "@list" || container === "@set";
        }
      }
      catch (error) {
        console.warn(`Failed to check ontology for property ${propertyId}: ${error.message}`);
      }
    }

    return false;
  }

  /**
   * Merge multiple resources with the same ID into a single resource
   * Handles property merging where single values become arrays when multiple values exist
   *
   * @param {Object[]} resources - Array of resources to merge (must have same _id or no _id)
   * @param {Object} [opts] - Options
   * @param {Object} [opts.context] - JSON-LD context for compaction
   * @param {boolean} [opts.compact=true] - Whether to compact the merged resource
   * @param {boolean} [opts.showContext=false] - Whether to include context in compacted resource
   * @param {boolean} [opts.ensureArrayProps=true] - Whether to ensure array properties are arrays
   * @returns {Promise<Object>} The merged resource
   */
  async mergeResources(resources, opts = {}) {
    check(resources, Array);
    check(opts, Match.Optional(Object));

    if (resources.length === 0) {
      throw new Error("Cannot merge empty array of resources");
    }

    if (resources.length === 1) {
      // Only one resource, return it (optionally compacted)
      const resource = resources[0];
      if (opts.compact !== false) {
        const ld = this.ld();
        const context = opts.context || await this.getContext();
        return await ld.compact(resource, context, {
          ensureArrayProps: opts.ensureArrayProps !== false,
          showContext: false,
          proxy: false
        });
      }
      return resource;
    }

    // Verify all resources have the same ID
    const firstId = resources[0]._id || resources[0]["@id"];
    if (!firstId) {
      throw new Error("Resources must have _id or @id for merging");
    }

    for (const resource of resources) {
      const resourceId = resource._id || resource["@id"];
      if (resourceId && resourceId !== firstId) {
        throw new Error(`All resources must have the same ID for merging. Expected ${firstId}, got ${resourceId}`);
      }
    }

    // Start with the first resource as base
    const merged = { ...resources[0] };

    // Merge properties from subsequent resources
    for (let i = 1; i < resources.length; i++) {
      const resource = resources[i];

      for (const [property, value] of Object.entries(resource)) {
        // Skip ID properties since they should be the same
        if (property === "_id" || property === "@id") {
          continue;
        }

        if (merged[property] === undefined) {
          // Property doesn't exist in merged resource, add it
          merged[property] = value;
        }
        else {
          // Property exists, need to merge values
          const existingValue = merged[property];
          const newValue = value;

          // Convert both to arrays for merging
          const isArray = Array.isArray(existingValue) || Array.isArray(newValue);
          const existingArray = Array.isArray(existingValue) ? existingValue : [existingValue];
          const newArray = Array.isArray(newValue) ? newValue : [newValue];

          // Merge arrays, avoiding duplicates
          const mergedArray = [...existingArray];
          for (const item of newArray) {
            // Check for duplicates using deep comparison for objects
            const isDuplicate = mergedArray.some(existing => {
              if (typeof existing === "object" && typeof item === "object") {
                // For objects, compare @id, @value, or entire object
                if (existing["@id"] && item["@id"]) {
                  return existing["@id"] === item["@id"];
                }
                if (existing["@value"] && item["@value"]) {
                  return existing["@value"] === item["@value"];
                }
                return JSON.stringify(existing) === JSON.stringify(item);
              }
              return existing === item;
            });

            if (!isDuplicate) {
              mergedArray.push(item);
            }
          }
          if (!isArray) {
            // the expected result is a single value, then the last value in mergedArray is
            // the last (most recent) update value
            merged[property] = mergedArray[mergedArray.length - 1];
          }
          else {
            merged[property] = mergedArray;
          }
        }
      }
    }

    // Compact the merged resource if requested
    if (opts.compact !== false) {
      // const LD = await import("bold-ld").then(m => m.LD);
      const ld = this.ld();
      const context = opts.context || await this.getContext();

      // Use isArrayProperty to determine which properties should be arrays
      if (opts.ensureArrayProps !== false) {
        for (const [property, value] of Object.entries(merged)) {
          if (property !== "_id" && property !== "@id" && property !== "@type") {
            const shouldBeArray = await this.isArrayProperty(property, { context });
            if (shouldBeArray && !Array.isArray(value)) {
              merged[property] = [value];
            }
          }
        }
      }

      return await ld.compact(merged, context, {
        ensureArrayProps: opts.ensureArrayProps !== false,
        showContext: !!opts.showContext,
        proxy: false
      });
    }

    return merged;
  }

  /**
   * Sort a list of class types/URIs by specificity (most specific to least specific)
   * Named classes are sorted above blank nodes. Blank nodes are sorted separately by specificity.
   *
   * @param {string[]} types - Array of class URIs/IDs to sort
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.cached=true] - Whether to use cached results
   * @returns {Promise<string[]>} Sorted array of types (most specific to least specific)
   */
  async sortTypesFn(types, opts = {}) {
    check(types, Array);
    check(opts, Match.Optional(Object));

    if (types.length <= 1) {
      return [...types]; // Return copy of array
    }

    // Separate named classes from blank nodes
    const namedClasses = types.filter(type => !type.startsWith("_:"));
    const blankNodes = types.filter(type => type.startsWith("_:"));

    // Sort named classes by specificity
    const sortedNamedClasses = await this._sortClassesBySpecificity(namedClasses, opts);

    // Sort blank nodes by specificity
    const sortedBlankNodes = await this._sortClassesBySpecificity(blankNodes, opts);

    // Return named classes first, then blank nodes
    return [...sortedNamedClasses, ...sortedBlankNodes];
  }

  /**
   * Sort classes by specificity using rdfs:subClassOf relationships
   * More specific classes (subclasses) come before less specific classes (superclasses)
   *
   * @param {string[]} classes - Array of class URIs/IDs to sort
   * @param {Object} [opts] - Options
   * @returns {Promise<string[]>} Sorted array of classes
   * @private
   */
  async _sortClassesBySpecificity(classes, opts = {}) {
    if (classes.length <= 1) {
      return [...classes];
    }

    try {
      // Build a resource cache by fetching all related classes from ontology
      // We'll gather the full inheritance tree by iteratively fetching classes
      const resourceCache = new Map();
      const classesToFetch = new Set(classes);
      const fetched = new Set();

      // Iteratively fetch classes and their parents until we have the full tree
      while (classesToFetch.size > 0) {
        const batch = Array.from(classesToFetch);
        classesToFetch.clear();

        // Fetch this batch of classes
        const cursor = this.collections.ontology.find({
          _id: { $in: batch }
        });
        const rawResults = await cursor.toArray();
        const results = rawResults.map(r => this.ld().proxy(r));

        // Cache the results and queue up parent classes
        for (const resource of results) {
          resourceCache.set(resource._id, resource);
          fetched.add(resource._id);

          // If this class has parents, queue them for fetching
          if (resource["rdfs:subClassOf"]) {
            const subClassOf = resource["rdfs:subClassOf"];
            const parents = Array.isArray(subClassOf) ? subClassOf : [subClassOf];
            const parentIds = parents
              .map(parent => typeof parent === "object" ? parent["@id"] || parent._id : parent)
              .filter(parent => parent && !fetched.has(parent));

            parentIds.forEach(parentId => classesToFetch.add(parentId));
          }
        }
      }

      // Now calculate depth for each class in the input list
      const depthMap = new Map();
      const depthCache = new Map();
      const subclassDepthMap = new Map();
      const subclassDepthCache = new Map();

      /**
       * Recursively calculate the depth of a class in the inheritance hierarchy
       * @param {string} className - The class to calculate depth for
       * @param {Set} visiting - Set of classes currently being visited (for cycle detection)
       * @returns {number} The depth (0 = no superclasses, higher = more specific)
       */
      const calculateDepth = (className, visiting = new Set()) => {
        // Check cache first
        if (depthCache.has(className)) {
          return depthCache.get(className);
        }

        // Cycle detection
        if (visiting.has(className)) {
          return 0;
        }

        // Get the class resource from cache
        const classResource = resourceCache.get(className);
        if (!classResource || !classResource["rdfs:subClassOf"]) {
          depthCache.set(className, 0);
          return 0;
        }

        visiting.add(className);

        // Get all parent classes
        const subClassOf = classResource["rdfs:subClassOf"];
        const parents = Array.isArray(subClassOf) ? subClassOf : [subClassOf];
        const parentIds = parents
          .map(parent => typeof parent === "object" ? parent["@id"] || parent._id : parent)
          .filter(parent => parent);

        // Calculate depth as 1 + max depth of all parents
        let maxParentDepth = 0;
        for (const parentId of parentIds) {
          const parentDepth = calculateDepth(parentId, new Set(visiting));
          maxParentDepth = Math.max(maxParentDepth, parentDepth);
        }

        const depth = 1 + maxParentDepth;
        visiting.delete(className);
        depthCache.set(className, depth);
        return depth;
      };

      /**
       * Calculate the maximum depth of the subclass hierarchy below this class
       * @param {string} className - The class to calculate subclass depth for
       * @param {Set} visiting - Set of classes currently being visited (for cycle detection)
       * @returns {number} The maximum depth of subclasses (0 = no subclasses)
       */
      const calculateSubclassDepth = (className, visiting = new Set()) => {
        // Check cache first
        if (subclassDepthCache.has(className)) {
          return subclassDepthCache.get(className);
        }

        // Cycle detection
        if (visiting.has(className)) {
          return 0;
        }

        visiting.add(className);

        // Find all classes that have this class as a parent
        const subclasses = [];
        for (const [resourceId, resource] of resourceCache.entries()) {
          if (resource["rdfs:subClassOf"]) {
            const subClassOf = resource["rdfs:subClassOf"];
            const parents = Array.isArray(subClassOf) ? subClassOf : [subClassOf];
            const parentIds = parents
              .map(parent => typeof parent === "object" ? parent["@id"] || parent._id : parent)
              .filter(parent => parent);

            if (parentIds.includes(className)) {
              subclasses.push(resourceId);
            }
          }
        }

        // Calculate depth as 1 + max depth of all subclasses
        let maxSubclassDepth = 0;
        for (const subclassId of subclasses) {
          const subclassDepth = calculateSubclassDepth(subclassId, new Set(visiting));
          maxSubclassDepth = Math.max(maxSubclassDepth, subclassDepth);
        }

        const depth = subclasses.length > 0 ? 1 + maxSubclassDepth : 0;
        visiting.delete(className);
        subclassDepthCache.set(className, depth);
        return depth;
      };

      // Calculate depths for all classes in the input list
      for (const className of classes) {
        const depth = calculateDepth(className);
        depthMap.set(className, depth);
        const subclassDepth = calculateSubclassDepth(className);
        subclassDepthMap.set(className, subclassDepth);
      }

      // Sort by depth (descending - most specific first)
      // If depths are equal, use subclass depth as tiebreaker (higher subclass depth = more general, comes later)
      const result = [...classes].sort((a, b) => {
        const depthA = depthMap.get(a) || 0;
        const depthB = depthMap.get(b) || 0;

        // Primary sort: by superclass depth (higher = more specific = comes first)
        if (depthA !== depthB) {
          return depthB - depthA;
        }

        // Tiebreaker: by subclass depth (higher = more general = comes earlier)
        const subDepthA = subclassDepthMap.get(a) || 0;
        const subDepthB = subclassDepthMap.get(b) || 0;
        return  subDepthB - subDepthA;
      });

      return result;
    }
    catch (error) {
      console.warn(`Failed to sort classes by specificity: ${error.message}`);
      // Fallback to original order
      return [...classes];
    }
  }

  /**
   * Get the assembled bui:schema for a property in the context of a resource,
   * or the class schema for a resource if no property is specified.
   *
   * When property is provided:
   * This function collects bui:schema definitions from multiple sources,
   * merged from least specific to most specific:
   * 1. The property definition itself (e.g., the ontology resource for "foo")
   * 2. All @types of the resource, walking up the rdfs:subClassOf hierarchy
   * 3. The resource instance itself (most specific override)
   *
   * For classes and resource instances, the bui:schema.properties[property]
   * subschema is extracted. Schemas are merged so more specific sources
   * override less specific ones.
   *
   * When property is NOT provided (class schema mode):
   * Returns the merged bui:schema for the resource's classes:
   * 1. Traverse @types from least to most specific (via rdfs:subClassOf)
   * 2. Merge bui:schema from each class directly
   * 3. Merge the resource instance's own bui:schema (most specific)
   *
   * @param {string} [property] - The property name (e.g., "foo"). If omitted, returns class schema.
   * @param {Object} [resource] - The resource context (used to determine @types and instance schema)
   * @param {Object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups (key: _id, value: resource)
   * @returns {Promise<Object>} The merged bui:schema object, or empty object if none found
   */
  async getSchema(property, resource, opts) {
    check(property, Match.Optional(String));
    check(resource, Match.Optional(Object));
    opts = opts || {};
    const cache = opts.ontologyCache;

    // Class schema mode: no property provided, but resource is
    if (!property && resource) {
      return this._getClassSchema(resource, cache);
    }

    // Property schema mode (original behavior)
    if (!property) {
      return {};
    }

    const schemas = await this._findSchemasWithProperty(resource, property, "bui:schema", cache);
    let mergedSchema = {};

    // Iterate from least to most specific (reverse order)
    // schemas array contains: [property, ...superclasses, ...directTypes]
    for (let i = schemas.length - 1; i >= 0; i--) {
      const schema = schemas[i];
      let buiSchema;

      // If schema is a class, look for bui:schema.properties[property]
      if (this._isClassResource(schema)) {
        const classSchema = schema["bui:schema"];
        if (classSchema?.properties?.[property] !== undefined) {
          buiSchema = classSchema.properties[property];
        }
      }
      // Otherwise (property definition), use bui:schema directly
      else if (schema["bui:schema"]) {
        buiSchema = schema["bui:schema"];
      }

      if (buiSchema) {
        mergedSchema = this._mergeSchemas(mergedSchema, buiSchema);
      }
    }

    // Finally, apply the resource instance's own bui:schema (most specific)
    if (resource && resource["bui:schema"]) {
      const instanceSchema = resource["bui:schema"];
      // For resource instances, look for bui:schema.properties[property]
      if (instanceSchema?.properties?.[property] !== undefined) {
        mergedSchema = this._mergeSchemas(mergedSchema, instanceSchema.properties[property]);
      }
    }

    return mergedSchema;
  }

  /**
   * Get the merged bui:schema for a resource's class hierarchy.
   * Traverses @types from least to most specific, merging bui:schema from each.
   *
   * @param {Object} resource - The resource to get class schema for
   * @param {Map} [cache] - Optional cache Map for ontology lookups
   * @returns {Promise<Object>} The merged class schema, or empty object if none found
   * @private
   */
  async _getClassSchema(resource, cache) {
    check(resource, Object);

    let mergedSchema = {};
    const exploredTypes = new Set();

    // Get resource types
    const resourceTypes = Array.isArray(resource["@type"])
      ? resource["@type"]
      : (resource["@type"] ? [resource["@type"]] : []);

    // Collect all class resources with their hierarchy depth
    const classesWithDepth = [];

    // Recursive function to walk up the class hierarchy and collect classes
    const collectClasses = async (typeId, depth) => {
      if (!typeId || exploredTypes.has(typeId) || typeId.startsWith("_:")) {
        return;
      }
      exploredTypes.add(typeId);

      const classResource = await this._cachedOntologyLookup(typeId, cache);

      if (classResource) {
        classesWithDepth.push({ resource: classResource, depth });

        // Walk up rdfs:subClassOf hierarchy
        if (classResource["rdfs:subClassOf"]) {
          const superClasses = Array.isArray(classResource["rdfs:subClassOf"])
            ? classResource["rdfs:subClassOf"]
            : [classResource["rdfs:subClassOf"]];

          for (const superClass of superClasses) {
            const superClassId = typeof superClass === "object"
              ? (superClass["@id"] || superClass._id)
              : superClass;
            await collectClasses(superClassId, depth + 1);
          }
        }
      }
    };

    // Collect all classes from resource types
    for (const typ of resourceTypes) {
      await collectClasses(typ, 0);
    }

    // Sort by depth descending (least specific first = highest depth)
    classesWithDepth.sort((a, b) => b.depth - a.depth);

    // Merge schemas from least to most specific
    for (const { resource: classResource } of classesWithDepth) {
      if (classResource["bui:schema"]) {
        mergedSchema = this._mergeSchemas(mergedSchema, classResource["bui:schema"]);
      }
    }

    // Finally, apply the resource instance's own bui:schema (most specific)
    if (resource["bui:schema"]) {
      mergedSchema = this._mergeSchemas(mergedSchema, resource["bui:schema"]);
    }

    return mergedSchema;
  }

  /**
   * Find all ontology resources that have a specified property and are related
   * to the given resource (through @type hierarchy) or are the property definition itself.
   *
   * @param {Object} [resource] - The resource to find schemas for
   * @param {string} property - The property name to look up
   * @param {string} ontologyProperty - The ontology property to search for (e.g., "bui:schema")
   * @param {Map} [cache] - Optional cache Map for ontology lookups
   * @returns {Promise<Object[]>} Array of ontology resources with the specified property
   * @private
   */
  async _findSchemasWithProperty(resource, property, ontologyProperty, cache) {
    check(resource, Match.Optional(Object));
    check(property, String);
    check(ontologyProperty, String);

    const foundSchemas = [];
    const exploredTypes = new Set();

    // First, check if the property itself has the ontology property
    const propertyDef = await this._cachedOntologyLookup(property, cache);
    if (propertyDef && propertyDef[ontologyProperty] !== undefined) {
      foundSchemas.push(propertyDef);
    }

    // If no resource provided, just return property schema
    if (!resource) {
      return foundSchemas;
    }

    // Get resource types
    const resourceTypes = Array.isArray(resource["@type"])
      ? resource["@type"]
      : (resource["@type"] ? [resource["@type"]] : []);

    // Breadth-first search across resource types
    for (const typ of resourceTypes) {
      if (exploredTypes.has(typ)) continue;
      exploredTypes.add(typ);

      const classResource = await this._cachedOntologyLookup(typ, cache);
      if (classResource && classResource[ontologyProperty] !== undefined) {
        foundSchemas.push(classResource);
      }
    }

    // Recursive function to walk up the class hierarchy
    const lookDeep = async (classResource) => {
      if (!classResource) return;

      // Check if this class has the ontology property
      if (classResource[ontologyProperty] !== undefined) {
        if (!exploredTypes.has(classResource._id)) {
          foundSchemas.push(classResource);
        }
      }

      if (!exploredTypes.has(classResource._id)) {
        exploredTypes.add(classResource._id);
      }

      // Walk up rdfs:subClassOf hierarchy
      if (classResource["rdfs:subClassOf"]) {
        const superClasses = Array.isArray(classResource["rdfs:subClassOf"])
          ? classResource["rdfs:subClassOf"]
          : [classResource["rdfs:subClassOf"]];

        for (const superClass of superClasses) {
          // Handle both string IDs and object references
          const superClassId = typeof superClass === "object"
            ? (superClass["@id"] || superClass._id)
            : superClass;

          if (superClassId && !exploredTypes.has(superClassId) && !superClassId.startsWith("_:")) {
            const superClassResource = await this._cachedOntologyLookup(superClassId, cache);
            if (superClassResource) {
              await lookDeep(superClassResource);
            }
          }
        }
      }
    };

    // Walk up hierarchy from each resource type
    for (const typ of resourceTypes) {
      const classResource = await this._cachedOntologyLookup(typ, cache);
      if (classResource) {
        await lookDeep(classResource);
      }
    }

    return foundSchemas;
  }

  async _findOntologyForResource(resource, property) {
    check(resource, Match.Optional(Object));
    check(property, Match.Optional(String));
    if (!resource && !property) {
      return [];
    }
    const foundOntology = [];
    const exploredTypes = new Set();

    // in this implementation "types" refers to the _ids of Ontology schemas.
    const resourceTypes = resource?.["@type"] || [];

    // Breadth-first search across resource types
    for (const typ of resourceTypes) {
      if (exploredTypes.has(typ)) continue;
      exploredTypes.add(typ);

      const rawClassResource = await this.collections.ontology.findOne({ _id: typ });
      const classResource = rawClassResource ? this.ld().proxy(rawClassResource) : null;
      if (classResource) {
        foundOntology.push(classResource);
      }

      // Recursive function to walk up the class hierarchy
      const lookDeep = async (classResource) => {
        if (!classResource) return;

        // Check if this class has the ontology property
        if (classResource[property] !== undefined) {
          if (!exploredTypes.has(classResource._id)) {
            foundOntology.push(classResource);
          }
        }

        if (!exploredTypes.has(classResource._id)) {
          exploredTypes.add(classResource._id);
        }

        // Walk up rdfs:subClassOf hierarchy
        if (classResource["rdfs:subClassOf"]) {
          const superClasses = Array.isArray(classResource["rdfs:subClassOf"])
            ? classResource["rdfs:subClassOf"]
            : [classResource["rdfs:subClassOf"]];

          for (const superClass of superClasses) {
            // Handle both string IDs and object references
            const superClassId = typeof superClass === "object"
              ? (superClass["@id"] || superClass._id)
              : superClass;

            if (superClassId && !exploredTypes.has(superClassId) && !superClassId.startsWith("_:")) {
              const rawSuperClassResource = await this.collections.ontology.findOne({ _id: superClassId });
              const superClassResource = rawSuperClassResource ? this.ld().proxy(rawSuperClassResource) : null;
              if (superClassResource) {
                await lookDeep(superClassResource);
              }
            }
          }
        }
      };

    }

  }
  /**
   * Check if a resource is a class (rdfs:Class, owl:Class)
   *
   * @param {Object} resource - The resource to check
   * @returns {boolean} True if the resource is a class
   * @private
   */
  _isClassResource(resource) {
    if (!resource || !resource["@type"]) {
      return false;
    }

    const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];
    const classTypes = [
      "rdfs:Class",
      "owl:Class",
      "http://www.w3.org/2000/01/rdf-schema#Class",
      "http://www.w3.org/2002/07/owl#Class"
    ];

    return types.some(t => classTypes.includes(t));
  }

  /**
   * Merge two schema objects, with arrays being merged using union.
   *
   * @param {Object} base - The base schema
   * @param {Object} override - The schema to merge on top
   * @returns {Object} The merged schema
   * @private
   */
  _mergeSchemas(base, override) {
    const result = { ...base };

    for (const [key, value] of Object.entries(override)) {
      if (result[key] === undefined) {
        result[key] = value;
      }
      else if (Array.isArray(result[key]) || Array.isArray(value)) {
        // Merge arrays using union
        const baseArr = Array.isArray(result[key]) ? result[key] : [result[key]];
        const overrideArr = Array.isArray(value) ? value : [value];
        // For arrays, override completely (like CTB behavior with _.union)
        result[key] = [...new Set([...baseArr, ...overrideArr])];
      }
      else if (typeof result[key] === "object" && typeof value === "object") {
        // Recursively merge objects
        result[key] = this._mergeSchemas(result[key], value);
      }
      else {
        // Override primitive values
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Return a list of collection names to search for id.
   * - the returned list typically begins with "ontology"
   * - if the id has a prefix which is the name of a collection, that follows "ontology"
   * - if the prefix has idResolvers in ontologize.opts, and if any of those match this id,
   *   then the collection named in the resolver will precede "ontology"
   * - then any other named collections are added
   * - "statements" is added last
   *
   * @param {string} id
   * @returns { string[] } list of collection names
   */
  getCollectionsForId(id) {
    check(id, String);
    // Define search order: Ontology first, then named collections, then Statements
    const searchOrder = ["ontology"];

    // app-specific collection hints will be in a plugin-fn for ontologize that will guess at the best collection based on id
    const prefix = id.match(/^([^:]+):/)?.[1];

    if (prefix) {
      // see if prefix has a named collection
      // (this will be searched after ontology)
      if (this.collections[prefix]) {
        searchOrder.push(prefix);
      }
      // TODO what about typeCollections?

      // do we have idResolvers for this prefix in our opts?
      if (this.opts.idResolvers?.[prefix]) {
        const resolvers = this.opts.idResolvers[prefix];
        if (Array.isArray(resolvers)) {
          for (const resolver of resolvers) {
            if (resolver.match) {
              const re = new RegExp(resolver.match);
              if (id.match(re) && resolver.collection) {
                // resolver.collection will be the registered name of the collection
                searchOrder.unshift(resolver.collection);
              }
            }
          }
        }
      }
    }

    // Add named collections (excluding Ontology, Context, Statements which are handled specially)
    const specialCollections = new Set(["ontology", "context", "statements"]);
    for (const collectionName of Object.keys(this.collections)) {
      if (!specialCollections.has(collectionName)  && !searchOrder.includes(collectionName)) {
        searchOrder.push(collectionName);
      }
    }

    // Add Statements last
    searchOrder.push("statements");
    return searchOrder;
  }

  /**
   * Get a resource by _id, searching across all registered collections.
   * Searches in this order:
   * 1. Ontology collection
   * 2. Named collections in opts.collections
   * 3. Statements collection
   *
   * @param {string} id - The _id of the resource to find
   * @returns {Promise<{collection: string, resource: Object}|null>} Object with collection name and resource, or null if not found
   */
  async getResourceForId(id) {
    check(id, String);
    if (!id) return null;

    // Define search order: Ontology first, then named collections, then Statements
    const searchOrder = this.getCollectionsForId(id); // ["ontology"];

    // Search each collection in order
    for (const collectionName of searchOrder) {
      const collection = this.collections[collectionName];
      if (!collection) continue;

      try {
        const raw = await collection.findOne({ _id: id });
        if (raw) {
          // TODO we probably shouldn't assume proxies
          const resource = this.ld().proxy(raw);
          return { collection: collectionName, resource };
        }
      }
      catch (error) {
        console.warn(`getResourceForId: Error searching ${collectionName}:`, error.message);
      }
    }

    return null;
  }

  /**
   * Get module version
   *
   * @returns {string} The module version
   */
  getVersion() {
    return this.version;
  }

  static DEFAULT_CONTEXT = {
    "@vocab" : "https://ontologize.2wav.com/ontology#",
    "rdf" : "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs" : "http://www.w3.org/2000/01/rdf-schema#",
    "owl" : "http://www.w3.org/2002/07/owl#",
    "xsd" : "http://www.w3.org/2001/XMLSchema#",
    "foaf" : "http://xmlns.com/foaf/0.1/",
    "dc" : "http://purl.org/dc/elements/1.1/",
    "org" : "http://www.w3.org/ns/org#",
    "uo" : "http://purl.obolibrary.org/obo/uo.owl",
    "obo" : "http://purl.obolibrary.org/obo/",
    "bfo" : "https://ontologize.2wav.com/ontology/bfo#",
    "ctb" : "https://ontologize.2wav.com/ontology/bridge#",
    "ctl" : "https://ontologize.2wav.com/ontology/800-53#",
    "ctl5" : "https://ontologize.2wav.com/ontology/800-53/rev5#",
    "nice" : "https://ontologize.2wav.com/ontology/nice#",
    "acrt" : "https://privatealpha.com/ontology/certification/1#",
    "time" : "http://www.w3.org/2006/time#",
    "skos" : "http://www.w3.org/2004/02/skos/core#",
    "wot" : "http://xmlns.com/wot/0.1/",
    "vs" : "http://www.w3.org/2003/06/sw-vocab-status/ns#",
    "brick": "https://brickschema.org/schema/Brick#",
    "csvw": "http://www.w3.org/ns/csvw#",
    "dcam": "http://purl.org/dc/dcam/",
    "dcat": "http://www.w3.org/ns/dcat#",
    "dcmitype": "http://purl.org/dc/dcmitype/",
    "dcterms": "http://purl.org/dc/terms/",
    "doap": "http://usefulinc.com/ns/doap#",
    "odrl": "http://www.w3.org/ns/odrl/2/",
    "prof": "http://www.w3.org/ns/dx/prof/",
    "prov": "http://www.w3.org/ns/prov#",
    "qb": "http://purl.org/linked-data/cube#",
    "schema": "https://schema.org/",
    "sh": "http://www.w3.org/ns/shacl#",
    "sosa": "http://www.w3.org/ns/sosa/",
    "ssn": "http://www.w3.org/ns/ssn/",
    "vann": "http://purl.org/vocab/vann/",
    "void": "http://rdfs.org/ns/void#",
    "_id" : "@id",
    "rdfs:range" : {
      "@type" : "@id"
    },
    "rdfs:domain" : {
      "@type" : "@id"
    },
    "org:memberDuring" : {
      "@type" : "@id"
    },
    "org:memberOf" : {
      "@type" : "@id"
    },
    "org:organization" : {
      "@type" : "@id"
    },
    "org:role" : {
      "@type" : "@id"
    },
    "rdfs:subClassOf" : {
      "@type" : "@id",
      "@container": "@set"
    },
    "dc:description" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "dcterms:license": {
      "@type": "@id"
    },
    "schema:eligibleRegion" : {

    },
    "rdfs:subPropertyOf" : {
      "@type" : "@id"
    },
    "vs:term_status" : {
      "@type" : "@id"
    },
    "wot:assurance" : {
      "@type" : "@id"
    },
    "wot:src_assurance" : {
      "@type" : "@id"
    },
    "owl:sameAs" : {
      "@type" : "@id"
    },
    "owl:cardinality": {
      "@type": "http://www.w3.org/2001/XMLSchema#integer"
    },
    "owl:maxCardinality": {
      "@type": "http://www.w3.org/2001/XMLSchema#integer"
    },
    "owl:allValuesFrom": {
      "@type" : "@id"
    },
    "owl:onProperty": {
      "@type" : "@id"
    },
    "owl:unionOf": {
      "@type" : "@id"
    },
    "owl:intersectionOf": {
      "@type" : "@id"
    },
    "owl:disjointWith": {
      "@type" : "@id"
    },
    "owl:inverseOf": {
      "@type" : "@id"
    },
    "owl:members": {
      "@type" : "@id"
    },
    "owl:versionIRI": {
      "@type" : "@id"
    }
  };

  // ============================================================================
  // Explorer Methods (client/server compatible)
  // ============================================================================

  /**
   * Explore the ontology structure showing classes, properties, and ontologies.
   * Scans registered collections for instance data (counts, instance properties).
   * Works on both client (Minimongo) and server (raw MongoDB collections).
   *
   * @param {Array<object>|Array<string>} [collections] - Collections to scan for instances.
   *   Array of collection objects or name strings. If omitted, all registered collections are used.
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.recurse=true] - Whether to recurse into embedded resources
   * @returns {Promise<Object>} Explorer data with Classes, Properties, and Ontologies sections
   */
  async explorer(collections, opts = {}) {
    check(opts, Match.Optional(Object));

    const resolvedCollections = this._resolveCollections(collections);
    opts.recurse = opts.recurse !== false;

    // Step 1: Get all classes from the ontology
    const allClasses = await this._getAllClassesFromOntology();

    // Step 2: Get direct superclasses (filters out redundant ancestors from reasoning)
    const directSuperclassMap = this._getDirectSuperclasses(allClasses);

    // Step 3: Order classes by specificity (least to most specific)
    const orderedClasses = await this._orderClassesBySpecificity(allClasses);

    // Step 4: For each class, get properties with this class as rdfs:domain
    const domainProperties = await this._getPropertiesByDomain();

    // Step 5: Collect properties directly found on instances of each class
    const { instanceProperties, individualCounts, individualQueries, locationsCt } = await this._getInstanceInfoByType(resolvedCollections, opts);

    // Step 6: Get all properties grouped by type
    const allProperties = await this._getAllPropertiesGroupedByType();

    // Step 7: Get all ontology resources
    const allOntologies = await this._getAllOntologies();

    // Step 8: Build the explorer map
    const ontMap = {};
    ontMap.README = "This is a JSON map of the ontology structure. Classes are ordered from least to most specific, showing domain properties and instance properties. Properties are grouped by ObjectProperties, DatatypeProperties, and general Properties. Ontologies shows loaded ontology definitions.";

    // Classes section
    ontMap.Classes = {};
    for (const className of orderedClasses) {
      const classInfo = allClasses[className] || {};

      ontMap.Classes[className] = {
        classInfo: classInfo,
        directSuperclasses: directSuperclassMap[className] || [],
        domainProperties: domainProperties[className] || {},
        instanceProperties: instanceProperties[className] || {},
        individualCt: individualCounts[className] || 0,
        individualQueries: individualQueries[className],
        locationsCt: locationsCt[className]
      };
    }

    // Properties section
    ontMap.Properties = allProperties;

    // Ontologies section
    ontMap.Ontologies = allOntologies;

    return ontMap;
  }

  /**
   * Resolve a collections argument to an array of collection objects.
   * @private
   * @param {Array<object>|Array<string>|undefined} collections
   *   - falsy or empty array → all registered collections
   *   - array of strings → resolve each name from this.collections
   *   - array of objects → pass through (backward compat)
   * @returns {Array<object>} Array of collection objects
   */
  _resolveCollections(collections) {
    if (!collections || (Array.isArray(collections) && collections.length === 0)) {
      return Object.values(this.collections);
    }

    if (!Array.isArray(collections)) {
      throw new Error("collections must be an array of collection names or collection objects");
    }

    // If first element is a string, resolve all as names
    if (typeof collections[0] === "string") {
      return collections.map(name => {
        const col = this.collections[name];
        if (!col) {
          throw new Error(`Unknown collection name: "${name}"`);
        }
        return col;
      });
    }

    // Otherwise assume array of collection objects (backward compat)
    return collections;
  }

  /**
   * Get properties found on instances grouped by their @type, and count individuals per type.
   * Works with both MongoDB raw collections (toArray) and Meteor Minimongo (fetch).
   * @private
   * @returns {{ instanceProperties: object, individualCounts: object }}
   */
  async _getInstanceInfoByType(collections, opts) {
    // this is a temporary fast hack to determine if a resource might have a location.
    const LOCATION_PROPS = [
      "geo:lat",
      "geo:long",
      "bold:spatialDepiction",
      "bold:spatialRange"
    ];
    const instanceProperties = {};
    const individualCounts = {};
    const individualQueries = {};
    const locationsCt = {};
    // Cache ontology lookups so each property is only queried once
    const ontologyCache = new Map();

    const lookupProperty = async (prop) => {
      if (ontologyCache.has(prop)) return ontologyCache.get(prop);
      const ontResource = await this.collections.ontology.findOne({ _id: prop });
      const result = ontResource || { propertyInfo: "No ontology definition found" };
      ontologyCache.set(prop, result);
      return result;
    };

    for (const collection of collections) {
      const collectionName = collection.collectionName || collection._name || "unknown";
      const cursor = collection.find();
      const documents = cursor.toArray ? await cursor.toArray() : cursor.fetch();

      for (const resource of documents) {
        const types = resource["@type"];
        if (!types) continue;
        const typeArray = Array.isArray(types) ? types : [types];
        for (const type of typeArray) {
          instanceProperties[type] = instanceProperties[type] || {};
          individualCounts[type] = (individualCounts[type] || 0) + 1;
          individualQueries[type] = individualQueries[type] || [];

          // Query we might add
          const queryName = `${type}-${collectionName}`;
          const foundQuery = individualQueries[type].find(q => q.name === queryName);
          if (foundQuery) {
            foundQuery.count += 1;
          }
          else {
            const query = new Query({
              name: `${type}-${collectionName}`,
              collection: collectionName,
              selector: { "@type": type },
              count: 1
            });
            individualQueries[type].push(query);
          }

          let hasLocation = false;
          // Add all properties found on this resource
          for (const prop in resource) {
            if (prop !== "@type" && prop !== "_id") {
              instanceProperties[type][prop] = await lookupProperty(prop);
              if (LOCATION_PROPS.includes(prop)) {
                hasLocation = true;
              }
            }
          }
          if (hasLocation) {
            locationsCt[type] = (locationsCt[type] || 0) + 1;
          }

          // Handle embedded resources if recursion is enabled
          if (opts.recurse && collectionName !== "bridge" && collectionName !== "statements") {
            const embeddedResources = this._findEmbeddedResources(resource);

            for (const embeddedResource of embeddedResources) {
              const embeddedTypes = embeddedResource["@type"];
              if (!embeddedTypes) continue;

              const embeddedTypeArray = Array.isArray(embeddedTypes) ? embeddedTypes : [embeddedTypes];

              for (const embeddedType of embeddedTypeArray) {
                instanceProperties[embeddedType] = instanceProperties[embeddedType] || {};
                individualCounts[embeddedType] = (individualCounts[embeddedType] || 0) + 1;

                for (const prop in embeddedResource) {
                  if (prop !== "@type" && prop !== "_id") {
                    instanceProperties[embeddedType][prop] = await lookupProperty(prop);
                  }
                }
              }
            }
          }
        }
      }
    }

    return { instanceProperties, individualCounts, individualQueries, locationsCt };
  }

  /**
   * Find embedded resources within a resource using JSON-LD patterns.
   * An embedded resource is any nested object with an @type property.
   * @private
   */
  _findEmbeddedResources(resource) {
    const embeddedResources = [];
    const paths = jsonPath(resource, "$..*['@type']", { resultType: "PATH" });

    if (paths) {
      for (const p of paths) {
        // Skip @context paths and root @type
        if (p.indexOf("@context") !== -1 || p === "$['@type']") {
          continue;
        }

        // Get the parent path (remove the ['@type'] part)
        const parentPath = p.substring(1, p.length - "['@type']".length);
        const embeddedResource = this._getByBracketPath(resource, parentPath);

        if (embeddedResource && !this._isType(embeddedResource, "rdf:Statement")) {
          embeddedResources.push(embeddedResource);
        }
      }
    }

    return embeddedResources;
  }

  /**
   * Navigate an object using a bracket-notation path from jsonPath (e.g., "['prop']['nested']").
   * Replaces lodash _.get for this specific use case.
   * @private
   */
  _getByBracketPath(obj, bracketPath) {
    if (!bracketPath) return obj;
    const keys = [];
    const re = /\['([^']+)'\]|\[(\d+)\]/g;
    let match;
    while ((match = re.exec(bracketPath)) !== null) {
      keys.push(match[1] !== undefined ? match[1] : Number(match[2]));
    }
    let current = obj;
    for (const key of keys) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }

  /**
   * Check if a resource has a given @type.
   * @private
   */
  _isType(resource, type) {
    const types = resource?.["@type"];
    if (!types) return false;
    const typeArray = Array.isArray(types) ? types : [types];
    const checkTypes = Array.isArray(type) ? type : [type];
    return typeArray.some(t => checkTypes.includes(t));
  }

  /**
   * Get all classes from the ontology collection
   * @private
   */
  async _getAllClassesFromOntology() {
    const classes = {};
    const cursor = this.collections.ontology.find({
      "@type": { $in: ["owl:Class", "rdfs:Class"] }
    });

    // Support both MongoDB (toArray) and Meteor (fetch) patterns
    const classResources = (cursor.toArray ? await cursor.toArray() : cursor.fetch()).map(r => this.ld().proxy(r));

    for (const classResource of classResources) {
      classes[classResource._id] = classResource;
    }

    return classes;
  }

  /**
   * Get direct (most specific) superclasses for each class, filtering out redundant ancestors.
   * After reasoning, rdfs:subClassOf contains the full transitive closure. This method
   * filters to only keep superclasses that are not themselves superclasses of other superclasses.
   * @param {Object} allClasses - Map of class ID to class resource
   * @returns {Object} Map of class ID to array of direct superclass IDs
   * @private
   */
  _getDirectSuperclasses(allClasses) {
    const directSuperclassMap = {};

    // First, build a map of all superclasses for each class
    const allSuperclassesMap = {};
    for (const className of Object.keys(allClasses)) {
      const classResource = allClasses[className];
      const subClassOf = classResource["rdfs:subClassOf"];
      if (subClassOf) {
        const parents = Array.isArray(subClassOf) ? subClassOf : [subClassOf];
        allSuperclassesMap[className] = parents.map(parent =>
          typeof parent === "object" ? parent["@id"] || parent._id : parent
        ).filter(parent => parent && !this._isBlankNodeId(parent));
      }
      else {
        allSuperclassesMap[className] = [];
      }
    }

    // For each class, filter to only direct superclasses
    for (const className of Object.keys(allClasses)) {
      const superclasses = allSuperclassesMap[className] || [];

      // A superclass S is direct if no other superclass T in the list has S as its superclass
      const directSuperclasses = superclasses.filter(superclass => {
        // Check if any other superclass in the list is a subclass of this one
        for (const otherSuperclass of superclasses) {
          if (otherSuperclass === superclass) continue;
          // If otherSuperclass has 'superclass' in its superclasses, then 'superclass' is not direct
          const otherAncestors = allSuperclassesMap[otherSuperclass] || [];
          if (otherAncestors.includes(superclass)) {
            return false; // This superclass is redundant
          }
        }
        return true;
      });

      directSuperclassMap[className] = directSuperclasses;
    }

    return directSuperclassMap;
  }

  /**
   * Order classes by specificity using rdfs:subClassOf relationships.
   * Returns array of class names ordered from least to most specific, with blank nodes at the end.
   * @private
   */
  async _orderClassesBySpecificity(allClasses) {
    const classNames = Object.keys(allClasses);

    // Separate blank nodes from named classes
    const namedClasses = classNames.filter(name => !this._isBlankNodeId(name));
    const blankNodes = classNames.filter(name => this._isBlankNodeId(name));

    // Get direct superclasses (filters out redundant ancestors from reasoning)
    const directSuperclassMap = this._getDirectSuperclasses(allClasses);

    // Build subclass relationships for named classes only
    const subClassMap = {};
    for (const className of namedClasses) {
      const directParents = directSuperclassMap[className] || [];
      subClassMap[className] = directParents.filter(parent => namedClasses.includes(parent));
    }

    // Topological sort to order by specificity (least to most specific)
    const visited = new Set();
    const result = [];
    const visiting = new Set();

    const visit = (className) => {
      if (visiting.has(className)) {
        // Circular dependency - skip to avoid infinite loop
        return;
      }
      if (visited.has(className)) {
        return;
      }

      visiting.add(className);

      // Visit all parent classes first (they are less specific)
      for (const parent of subClassMap[className] || []) {
        if (namedClasses.includes(parent)) {
          visit(parent);
        }
      }

      visiting.delete(className);
      visited.add(className);
      result.push(className);
    };

    // Visit all named classes first
    for (const className of namedClasses) {
      visit(className);
    }

    // Add blank nodes at the end, sorted alphabetically for consistency
    const sortedBlankNodes = blankNodes.sort();
    result.push(...sortedBlankNodes);

    return result;
  }

  /**
   * Check if a class name is a blank node (starts with _:)
   * @private
   */
  _isBlankNodeId(className) {
    return typeof className === "string" && className.startsWith("_:");
  }

  /**
   * Get all properties grouped by their rdfs:domain
   * @private
   */
  async _getPropertiesByDomain() {
    const domainMap = {};
    const cursor = this.collections.ontology.find({
      "@type": {
        $in: ["owl:ObjectProperty", "owl:DatatypeProperty", "owl:AnnotationProperty", "rdf:Property"]
      }
    });

    // Support both MongoDB (toArray) and Meteor (fetch) patterns
    const rawProperties = cursor.toArray ? await cursor.toArray() : cursor.fetch();
    const properties = rawProperties.map(r => this.ld().proxy(r));

    for (const property of properties) {
      const domain = property["rdfs:domain"];
      if (domain) {
        const domains = Array.isArray(domain) ? domain : [domain];

        for (const domainValue of domains) {
          const domainClass = typeof domainValue === "object" ?
            (domainValue["@id"] || domainValue._id) : domainValue;

          if (domainClass) {
            domainMap[domainClass] = domainMap[domainClass] || {};
            domainMap[domainClass][property._id] = property;
          }
        }
      }
    }

    return domainMap;
  }

  /**
   * Get all properties from the ontology grouped by their types
   * @private
   */
  async _getAllPropertiesGroupedByType() {
    const propertiesGrouped = {
      ObjectProperties: {},
      DatatypeProperties: {},
      AnnotationProperties: {},
      Properties: {}
    };

    const cursor = this.collections.ontology.find({
      "@type": {
        $in: ["owl:ObjectProperty", "owl:DatatypeProperty", "owl:AnnotationProperty", "rdf:Property"]
      }
    });

    // Support both MongoDB (toArray) and Meteor (fetch) patterns
    const rawProperties = cursor.toArray ? await cursor.toArray() : cursor.fetch();
    const properties = rawProperties.map(r => this.ld().proxy(r));

    for (const property of properties) {
      const types = Array.isArray(property["@type"]) ? property["@type"] : [property["@type"]];

      if (types.includes("owl:ObjectProperty")) {
        propertiesGrouped.ObjectProperties[property._id] = property;
      }
      else if (types.includes("owl:DatatypeProperty")) {
        propertiesGrouped.DatatypeProperties[property._id] = property;
      }
      else if (types.includes("owl:AnnotationProperty")) {
        propertiesGrouped.AnnotationProperties[property._id] = property;
      }
      else if (types.includes("rdf:Property")) {
        propertiesGrouped.Properties[property._id] = property;
      }
    }

    return propertiesGrouped;
  }

  /**
   * Get all ontology resources from the ontology collection
   * @private
   */
  async _getAllOntologies() {
    const ontologies = {};
    const cursor = this.collections.ontology.find({
      "@type": { $in: ["owl:Ontology"] }
    });

    // Support both MongoDB (toArray) and Meteor (fetch) patterns
    const rawOntologyResources = cursor.toArray ? await cursor.toArray() : cursor.fetch();
    const ontologyResources = rawOntologyResources.map(r => this.ld().proxy(r));

    for (const ontologyResource of ontologyResources) {
      ontologies[ontologyResource._id] = ontologyResource;
    }

    return ontologies;
  }

  // ============================================================================
  // Individual Methods (for grouping resources by individual)
  // ============================================================================

  /**
   * Default color scheme for individuals.
   * Based on d3.schemeTableau10 but excludes red (#e15759) and pink (#ff9da7)
   * to avoid confusion with selection/error states.
   */
  static DEFAULT_COLOR_SCHEME = [
    "#4e79a7", "#f28e2c", "#76b7b2", "#59a14f",
    "#edc949", "#af7aa1", "#9c755f", "#bab0ab"
  ];

  /**
   * Group resources by individual ID.
   *
   * @deprecated Use groupResources() with a group strategy object instead.
   * @param {Object[]} resources - Array of resources to group
   * @param {Function} getIndividualId - Function that takes a resource and returns its individual ID
   * @returns {Map<string, Object[]>} Map of individual ID to array of resources
   */
  groupResourcesByIndividual(resources, getIndividualId) {
    check(resources, Array);
    check(getIndividualId, Function);

    const map = new Map();
    for (const resource of resources) {
      const id = getIndividualId(resource);
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(resource);
    }
    return map;
  }

  /**
   * Assign colors to individual IDs from a color scheme.
   * Pure function - does not use ontologize internals.
   *
   * @param {string[]} ids - Array of individual IDs
   * @param {string[]} [scheme] - Color scheme array (defaults to Ontologize.DEFAULT_COLOR_SCHEME)
   * @returns {Map<string, string>} Map of individual ID to hex color
   */
  assignIndividualColors(ids, scheme = Ontologize.DEFAULT_COLOR_SCHEME) {
    check(ids, Array);

    const map = new Map();
    ids.forEach((id, i) => map.set(id, scheme[i % scheme.length]));
    return map;
  }

  /**
   * Fetch labels for individual IDs by looking up resources in collections.
   * Uses ontologize internals (getResourceForId, getLabel).
   *
   * @param {string[]} ids - Array of individual IDs to fetch labels for
   * @returns {Promise<Map<string, string>>} Map of individual ID to label string
   */
  async fetchIndividualLabels(ids) {
    check(ids, Array);

    const map = new Map();
    await Promise.all(ids.map(async (id) => {
      try {
        const result = await this.getResourceForId(id);
        if (result && result.resource) {
          const label = await this.getLabel(result.resource);
          map.set(id, label);
        }
        else {
          map.set(id, String(id));
        }
      }
      catch (error) {
        console.warn(`fetchIndividualLabels: Error fetching label for ${id}:`, error.message);
        map.set(id, String(id));
      }
    }));
    return map;
  }

  /**
   * Build individual options array with _id, label, color, and count.
   * Convenience method combining groupResourcesByIndividual, assignIndividualColors, and fetchIndividualLabels.
   *
   * @deprecated Use buildGroupOptions() with a group strategy object instead.
   * @param {Object[]} resources - Array of resources to process
   * @param {Function} getIndividualId - Function that takes a resource and returns its individual ID
   * @param {string[]} [colorScheme] - Color scheme array (defaults to Ontologize.DEFAULT_COLOR_SCHEME)
   * @returns {Promise<Object[]>} Array of { _id, label, color, count } objects
   */
  async buildIndividualOptions(resources, getIndividualId, colorScheme) {
    check(resources, Array);
    check(getIndividualId, Function);

    const map = this.groupResourcesByIndividual(resources, getIndividualId);
    const ids = [...map.keys()];
    const colors = this.assignIndividualColors(ids, colorScheme);
    const labels = await this.fetchIndividualLabels(ids);

    return ids.map(id => ({
      _id: id,
      label: labels.get(id),
      color: colors.get(id),
      count: map.get(id).length
    }));
  }

  /**
   * Get available group strategies for a resource from its class schema.
   * Calls _getClassSchema to get the merged bui:schema and returns the groups array.
   * Deduplicates by property name (since _mergeSchemas uses Set with reference equality
   * on objects, inherited group objects from different class levels won't be deduped).
   *
   * @param {Object} resource - A resource to discover group strategies for
   * @param {Object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups
   * @returns {Promise<Array<{label: string, property: string}>>} Array of group strategy objects
   */
  async getGroupStrategies(resource, opts) {
    check(resource, Object);
    opts = opts || {};

    const schema = await this._getClassSchema(resource, opts.ontologyCache);
    const groups = schema.groups || [];

    // Deduplicate by property name
    const seen = new Set();
    const deduped = [];
    for (const group of groups) {
      if (!seen.has(group.property)) {
        seen.add(group.property);
        deduped.push(group);
      }
    }

    return deduped;
  }

  /**
   * Group resources by a group strategy's property.
   * Resources with a falsy group property value go into a null-keyed bucket.
   *
   * @param {Object[]} resources - Array of resources to group
   * @param {Object} group - Group strategy object with { label, property }
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.includeUngrouped=true] - Whether to include the null bucket for ungrouped resources
   * @returns {Map<string|null, Object[]>} Map of group key to array of resources
   */
  groupResources(resources, group, opts) {
    check(resources, Array);
    check(group, Object);
    opts = opts || {};
    const includeUngrouped = opts.includeUngrouped !== false;

    const map = new Map();
    for (const resource of resources) {
      const key = resource[group.property] || null;
      if (key === null && !includeUngrouped) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(resource);
    }
    return map;
  }

  /**
   * Build group options array with _id, label, color, and count.
   * Like buildIndividualOptions but driven by a group strategy object.
   * Appends a "No Group" option with neutral color if ungrouped resources exist.
   *
   * @param {Object[]} resources - Array of resources to process
   * @param {Object} group - Group strategy object with { label, property }
   * @param {string[]} [colorScheme] - Color scheme array (defaults to Ontologize.DEFAULT_COLOR_SCHEME)
   * @returns {Promise<Object[]>} Array of { _id, label, color, count } objects
   */
  async buildGroupOptions(resources, group, colorScheme) {
    check(resources, Array);
    check(group, Object);

    const map = this.groupResources(resources, group);
    const ids = [...map.keys()].filter(id => id !== null);
    const colors = this.assignIndividualColors(ids, colorScheme);
    const labels = await this.fetchIndividualLabels(ids);

    const options = ids.map(id => ({
      _id: id,
      label: labels.get(id),
      color: colors.get(id),
      count: map.get(id).length
    }));

    // Append "No Group" option if there are ungrouped resources
    if (map.has(null)) {
      options.push({
        _id: null,
        label: "No Group",
        color: "#cccccc",
        count: map.get(null).length
      });
    }

    return options;
  }
}

// Export the class as default
export default Ontologize;
