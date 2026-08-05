/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check, Match } from "../lib/check.js";
import _ from "lodash";
import { format } from "date-fns";
import { TZDate, tzName } from "@date-fns/tz";
import { ApiNamespace } from "./ApiNamespace.js";

/**
 * `ontologize.display` — UI-facing presentation helpers: labels, descriptions,
 * date formatting, info-component and label resolvers, and individual color /
 * grouping utilities. Schema lookups go through `this.ontologize.schema`; label
 * and description preference lists come from `this.opts.labelProperties` /
 * `this.opts.descriptionProperties`.
 */
export class DisplayApi extends ApiNamespace {
  /**
   * Default color scheme for individuals.
   * Based on d3.schemeTableau10 but excludes red (#e15759) and pink (#ff9da7)
   * to avoid confusion with selection/error states.
   */
  static DEFAULT_COLOR_SCHEME = [
    "#4e79a7", "#f28e2c", "#76b7b2", "#59a14f",
    "#edc949", "#af7aa1", "#9c755f", "#bab0ab"
  ];

  // A zone-less ISO 8601 value: a date, optionally followed by a wall-clock time,
  // with no trailing "Z" and no ±hh:mm offset. Field ranges are bounded here so
  // impossible values (month 13, hour 25) never reach the date constructor.
  static ZONELESS_ISO =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?)?$/;

  /**
   * @param {import("../Ontologize.js").Ontologize} ontologize
   */
  constructor(ontologize) {
    super(ontologize);
    // Optional application-registered resolvers (see setInfoComponentResolver /
    // setLabelResolver). Held on the display namespace; the owning Ontologize
    // constructor forwards its infoComponentResolver / labelResolver opts here.
    this._infoComponentResolver = null;
    this._labelResolver = null;
  }

  /**
   * Register a resolver that picks a Vue component to render info for a
   * given resource. Used by GeoView's NodeInfoPlugin (and any host that
   * wants ontology-driven UI selection). Applications typically call this
   * once at startup, passing a function that closes over imported Vue
   * components. Pass `null` to clear.
   *
   * @param {Function|null} resolver
   *   - resolver(resource, hint?) → Vue component | null
   *   - hint may include { kind: "raw"|"summary", feature }
   *   - returning null lets the caller fall back to its default.
   */
  setInfoComponentResolver(resolver) {
    if (resolver !== null && typeof resolver !== "function") {
      throw new Error("Ontologize.setInfoComponentResolver: resolver must be a function or null");
    }
    this._infoComponentResolver = resolver;
  }

  /**
   * Pick a Vue component to render info for the given resource. Returns
   * null when no resolver is registered or the resolver opts out, so the
   * caller (e.g. NodeInfoPlugin) can supply its own fallback (e.g.
   * MinimalNodeInfo, ResourceViewer).
   *
   * @param {Object} resource
   * @param {Object} [hint]   { kind: "raw"|"summary", feature } (optional)
   * @returns {*}             a Vue component (whatever the resolver returned), or null
   */
  getInfoComponent(resource, hint) {
    if (typeof this._infoComponentResolver !== "function") return null;
    try {
      return this._infoComponentResolver(resource, hint) ?? null;
    }
    catch (err) {
      console.error("[Ontologize] infoComponentResolver threw:", err);
      return null;
    }
  }

  /**
   * Register an application-specific label resolver. Called by `getLabel`
   * when no standard label property is found, before falling back to ID
   * parsing. Return a non-null string to supply the label; return
   * null/undefined to decline and let the default fallback run.
   * Pass `null` to clear a previously registered resolver.
   *
   * @param {Function|null} resolver  async (resource, opts) => string|null
   */
  setLabelResolver(resolver) {
    if (resolver !== null && typeof resolver !== "function") {
      throw new Error("Ontologize.setLabelResolver: resolver must be a function or null");
    }
    this._labelResolver = resolver;
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

    // Copy, don't alias: the class-level override below unshifts onto this
    // list, and `this.opts.labelProperties` is the shared instance array. A
    // bare reference made every call permanently prepend to the global
    // preference order — unbounded growth, and one class's override leaking
    // into every other class's lookups.
    const labelProperties = [...this.opts.labelProperties];
    // Get the assembled schema to check for label or labelProperties override
    const schema = await this.ontologize.schema.getSchema(property, resource, opts);
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
      examineResource = await this.ontologize._cachedOntologyLookup(property, cache);
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

    // Application-specific label resolver — runs before ID-based fallback
    if (this._labelResolver) {
      try {
        const resolved = await this._labelResolver(resource, opts);
        if (resolved != null) return resolved;
      }
      catch (err) {
        console.error("[Ontologize] labelResolver threw:", err);
      }
    }

    const _id = resource._id ? "_id" : "@id";
    if (resource[_id]) {
      // find a type name
      let typeName;
      if (resource["@type"]?.[0]) {
        const found = await this.ontologize.getResourceForId(resource["@type"][0]);
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
    const classSchema = await this.ontologize.schema.getSchema(undefined, resource);
    const labelProperties = classSchema?.labelProperties || this.opts.labelProperties;

    // Check label properties in order of preference
    for (const prop of labelProperties) {
      if (resource[prop]) {
        return prop;
      }
    }

    return fallback || this.opts.labelProperties[this.opts.labelProperties.length - 1];
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

    // Note: fallback is description *text*, while getDescriptionProperty's fallback
    // is a property *name*, so it is deliberately not passed through.
    const prop = await this.getDescriptionProperty(resource);
    const value = resource[prop];

    // getDescriptionProperty returns the most generic property even when the
    // resource carries no description, so the value may be undefined.
    if (value === undefined || value === null) {
      return fallback || "";
    }

    if (this.ld().isProxy(resource)) {
      return value;
    }

    return Array.isArray(value) ? value[0] : value;
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
    const classSchema = await this.ontologize.schema.getSchema(undefined, resource);
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
   * Parse a zone-less ISO 8601 string as wall-clock fields in a given timezone.
   *
   * "2026-08-10" and "2026-08-10T14:30:00" carry no offset, so they name calendar
   * fields rather than an instant. ECMA-262 resolves the first against UTC and the
   * second against the machine's zone; both readings can land on a different day
   * once the value is rendered in a display timezone. This resolves either against
   * the timezone it will be displayed in, so the date survives the round trip.
   *
   * Values that are already instants (offset- or Z-bearing strings, timestamps,
   * Date objects) do not match and are left to the caller.
   *
   * @param {*} value - The candidate value
   * @param {string} timeZone - IANA timezone the wall-clock fields belong to
   * @returns {{matched: boolean, date: TZDate|null}} `matched` is false when the
   *   value is not a zone-less ISO string; when it is, `date` is null if the fields
   *   name no real date (e.g. "2026-02-30")
   */
  static parseZonelessISO(value, timeZone) {
    const match = typeof value === "string" ? DisplayApi.ZONELESS_ISO.exec(value.trim()) : null;
    if (!match) {
      return { matched: false, date: null };
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    // Fractional seconds may carry any precision; scale to milliseconds.
    const ms = match[7] ? Math.round(Number("0." + match[7]) * 1000) : 0;

    const date = new TZDate(year, month - 1, day, hour, minute, second, ms, timeZone);

    // The component constructor rolls overflow over rather than failing (Feb 30
    // becomes Mar 2), so confirm the calendar date survived. Only the date fields
    // are checked: a DST spring-forward legitimately moves the clock time, but
    // always forward within the same day.
    if (isNaN(date.getTime()) ||
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day) {
      return { matched: true, date: null };
    }
    return { matched: true, date };
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
      // A zone-less ISO string names wall-clock fields, not an instant. Resolve it
      // against dateTimeZone so the day that was written is the day that displays;
      // Date's own parser would resolve it against UTC (date-only) or the machine's
      // zone (date-time), either of which can shift it across midnight on the way in.
      const zoneless = DisplayApi.parseZonelessISO(dateValue, dateTimeZone);
      if (zoneless.matched) {
        // Well-formed but not a real date (e.g. Feb 30). Stop here rather than
        // falling back to Date's parser, which would roll it into another day.
        if (!zoneless.date) {
          return "";
        }
        dateObj = zoneless.date;
      }
      else {
        dateObj = new Date(dateValue);
      }
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
   * Assign colors to individual IDs from a color scheme.
   * Pure function - does not use ontologize internals.
   *
   * @param {string[]} ids - Array of individual IDs
   * @param {string[]} [scheme] - Color scheme array (defaults to DisplayApi.DEFAULT_COLOR_SCHEME)
   * @returns {Map<string, string>} Map of individual ID to hex color
   */
  assignIndividualColors(ids, scheme = DisplayApi.DEFAULT_COLOR_SCHEME) {
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
        const result = await this.ontologize.getResourceForId(id);
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
   * Build group options array with _id, label, color, and count.
   * Appends a "No Group" option with neutral color if ungrouped resources exist.
   *
   * @param {Object[]} resources - Array of resources to process
   * @param {Object} group - Group strategy object with { label, property }
   * @param {string[]} [colorScheme] - Color scheme array (defaults to DisplayApi.DEFAULT_COLOR_SCHEME)
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

export default DisplayApi;
