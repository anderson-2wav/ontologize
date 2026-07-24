/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { ApiNamespace } from "../ApiNamespace.js";

/**
 * JSON-property helper store, shared by the `io` and `rdf` server namespaces.
 * Detects properties whose range is a bold:JSON / bui:Schema type and
 * stringifies / parses their POJO values around JSON-LD processing, caching
 * lookups per ontology load. Held on the OntologizeServer instance as
 * `this._jsonProps`; not a public API namespace. Reads the JSON-type constants
 * from the owning class via `this.ontologize.constructor`.
 */
export class JsonPropertyStore extends ApiNamespace {
  constructor(ontologize) {
    super(ontologize);
    this._jsonPropertyLookupCache = null;
    this._jsonPropertyIdsCache = null;
  }

  /**
   * Clear the JSON property caches (call when the ontology changes).
   */
  clear() {
    this._jsonPropertyLookupCache = null;
    this._jsonPropertyIdsCache = null;
  }

  /**
   * Check if a property has a bold:JSON or bui:Schema range (or subclass).
   * These properties require special handling during import/export.
   *
   * @param {string|object} propertyResourceOrId - The property identifier (e.g., "bui:schema")
   * @returns {Promise<boolean>} True if the property has a JSON-type range
   * @private
   */
  async _isJsonProperty(propertyResourceOrId) {
    if (!propertyResourceOrId) return false;
    const propertyId = typeof propertyResourceOrId === "string" ? propertyResourceOrId : propertyResourceOrId._id;

    // Check cache first
    if (!this._jsonPropertyLookupCache) {
      this._jsonPropertyLookupCache = new Map();
    }
    if (this._jsonPropertyLookupCache.has(propertyId)) {
      return this._jsonPropertyLookupCache.get(propertyId);
    }

    // Look up property definition in Ontology collection
    const propertyDef = typeof propertyResourceOrId === "object" ? propertyResourceOrId : await this.collections.ontology.findOne({ _id: propertyResourceOrId });
    if (!propertyDef) {
      // too early to say this...
      // this._jsonPropertyLookupCache.set(propertyId, false);
      return false;
    }

    // Check for explicit bold:isJsonProperty marker
    if (propertyDef["bold:isJsonProperty"] === true) {
      this._jsonPropertyLookupCache.set(propertyId, true);
      return true;
    }

    // Check rdfs:range
    const range = propertyDef["rdfs:range"];
    if (range && this.ontologize.constructor.BUI_JSON_TYPES.includes(range)) {
      this._jsonPropertyLookupCache.set(propertyId, true);
      return true;
    }

    this._jsonPropertyLookupCache.set(propertyId, false);
    return false;
  }

  /**
   * Get all known JSON-type property IDs from the Ontology collection.
   * Caches results for performance.
   *
   * @returns {Promise<Set<string>>} Set of property IDs with JSON-type ranges
   * @private
   */
  async _getJsonPropertyIds(useCache = true) {
    if (!this._jsonPropertyIdsCache) {
      this._jsonPropertyIdsCache = new Set();
    }
    const jsonProps = this._jsonPropertyIdsCache;
    if (useCache && this._jsonPropertyIdsCache.size) {
      return this._jsonPropertyIdsCache;
    }

    // Find properties with bold:JSON or bui:Schema range
    const cursor = this.collections.ontology.find({
      $or: [
        { "rdfs:range": { $in: this.ontologize.constructor.BUI_JSON_TYPES } },
        { "bold:isJsonProperty": true }
      ]
    });

    const props = await cursor.toArray();
    for (const prop of props) {
      if (prop._id) {
        jsonProps.add(prop._id);
      }
    }
    // some props are defaulted in so that we can recognize them before their actual ontology files are bootstrapped,
    // e.g. bui:schema
    for (const prop of this.ontologize.constructor.BUI_JSON_PROPERTIES) {
      jsonProps.add(prop);
    }
    return jsonProps;
  }

  /**
   * Pre-process a resource before JSON-LD expansion/compaction.
   * Stringifies POJO values on bold:JSON/bui:Schema properties to prevent
   * the JSON-LD processor from altering their structure.
   *
   * @param {Object} resource - The resource to process
   * @returns {Promise<Object>} Resource with JSON property values stringified
   * @private
   */
  async _stringifyJsonProperties(resource, opts = {}) {
    opts.useCache = opts.useCache !== false;
    const jsonPropertyIds = await this._getJsonPropertyIds(opts.useCache);
    if (jsonPropertyIds.size === 0) {
      return resource;
    }

    const processed = { ...resource };
    for (const propId of jsonPropertyIds) {
      if (propId in processed) {
        const value = processed[propId];
        // Only stringify if it's a POJO (not already a string)
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          processed[propId] = JSON.stringify(value);
        }
        else if (Array.isArray(value)) {
          // Handle array of POJOs
          processed[propId] = value.map(v =>
            (v !== null && typeof v === "object") ? JSON.stringify(v) : v
          );
        }
      }
    }

    return processed;
  }

  /**
   * Post-process a resource after JSON-LD expansion/compaction.
   * Parses JSON string values back to POJOs for bui:JSON/bui:Schema properties.
   *
   * @param {Object} resource - The resource to process
   * @returns {Promise<Object>} Resource with JSON property values parsed
   * @private
   */
  async _parseJsonProperties(resource) {
    const jsonPropertyIds = await this._getJsonPropertyIds();
    if (jsonPropertyIds.size === 0) {
      return resource;
    }

    const processed = { ...resource };
    for (const propId of jsonPropertyIds) {
      if (propId in processed) {
        let value = processed[propId];
        // NASTY... we can get a variety of mess from ld.compact for properties with context @type: @json, like:
        const ex = {
          "@type": [
            "@json"
          ],
          "@value": {
            "properties": {
              //...
            }
          }
        };
        // look for a { @value } object, convert it
        if (value["@value"]) {
          value = value["@value"];
        }
        // Parse string values back to POJOs
        if (typeof value === "string") {
          try {
            processed[propId] = JSON.parse(value);
          }
          catch (e) {
            // Not valid JSON, leave as string
          }
        }
        else if (Array.isArray(value)) {
          // Handle array of JSON strings
          processed[propId] = value.map(v => {
            if (typeof v === "string") {
              try {
                return JSON.parse(v);
              }
              catch (e) {
                return v;
              }
            }
            return v;
          });
        }
      }
    }

    return processed;
  }
}

export default JsonPropertyStore;
