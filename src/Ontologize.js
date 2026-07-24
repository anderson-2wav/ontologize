/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check, Match } from "./lib/check.js";
import LD from "bold-ld";
import { ExploreApi } from "./api/ExploreApi.js";
import { GeoApi } from "./api/GeoApi.js";
import { SchemaApi } from "./api/SchemaApi.js";
import { DisplayApi } from "./api/DisplayApi.js";
import { CLIENT_FLAT_API, installFlatApi } from "./api/flatApi.js";

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

  // Default color scheme for individuals. The array now lives on DisplayApi
  // (where assignIndividualColors / buildGroupOptions consume it); re-exported
  // here for back-compat with callers reading Ontologize.DEFAULT_COLOR_SCHEME.
  static DEFAULT_COLOR_SCHEME = DisplayApi.DEFAULT_COLOR_SCHEME;

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

    // Optional resolvers now live on the `display` namespace (DisplayApi holds
    // the state and the setters). Forward the constructor opts to it. Most apps
    // register post-init via ontologize.display.setInfoComponentResolver() /
    // setLabelResolver() so the functions can close over imported Vue components.
    //   - infoComponentResolver: used by GeoView's NodeInfoPlugin
    //     (geo-plugins-spec.md §4.2) to pick a Vue component for a resource.
    //   - labelResolver: called by getLabel when no standard label property is
    //     found, before the ID-based fallback.
    if (this.opts.infoComponentResolver) {
      this.display.setInfoComponentResolver(this.opts.infoComponentResolver);
    }
    if (this.opts.labelResolver) {
      this.display.setLabelResolver(this.opts.labelResolver);
    }

    // Initialize the singleton LD instance for this Ontologize instance.
    //
    // The context collection may answer synchronously (a plain in-memory store)
    // or asynchronously (MeteorCollectionAdapter and HttpCollectionAdapter both
    // declare findOne async, so both always hand back a Promise). Synchronous
    // answers build LD immediately so `ld()` works without ceremony;
    // asynchronous ones are tracked by `_ldReady`, which `ready()` exposes.
    //
    // Callers must `await ontologize.ready()` before touching `ld()` in the
    // async case. `ld()` throws rather than fabricating a context-less LD —
    // that fallback silently produced uncompacted results and hid the race.
    this._ld = null;
    const pendingContext = this.collections.context.findOne({ _id: "@id" });
    if (pendingContext instanceof Promise) {
      this._ldReady = pendingContext.then((context) => {
        this._ld = this._buildLD(context);
        return this;
      });
    }
    else {
      this._ld = this._buildLD(pendingContext);
      this._ldReady = Promise.resolve(this);
    }
  }

  /**
   * Build the LD instance for a fetched context document.
   *
   * @param {object|null} context - the `@id` context doc, or null if absent
   * @returns {LD}
   * @private
   */
  _buildLD(context) {
    return new LD({
      context: context ?? {},
      proxy: this.opts.proxy,
      sortTypesFn: (types, opts) => this.schema.sortTypesFn(types, opts)
    });
  }

  /**
   * Resolve once the JSON-LD context has loaded and `ld()` is usable.
   *
   * Required before any use of a collection whose `findOne` is asynchronous —
   * which is every adapter. Safe and cheap to call repeatedly.
   *
   * @returns {Promise<Ontologize>} this instance
   */
  async ready() {
    await this._ldReady;
    return this;
  }

  /**
   * Get the singleton LD instance for this Ontologize instance.
   *
   * @returns {LD} The LD instance
   * @throws {Error} If the context has not loaded yet — `await ready()` first
   */
  ld() {
    if (!this._ld) {
      throw new Error(
        "Ontologize.ld() called before the JSON-LD context finished loading. " +
        "Await ontologize.ready() after initialize() before rendering."
      );
    }
    return this._ld;
  }

  // ==========================================================================
  // API namespaces
  //
  // Cohesive groups of methods, lazily instantiated so construction order never
  // matters. The former flat methods (ontologize.explorer(), etc.) remain as
  // deprecated delegates installed via installFlatApi() at the bottom of this
  // file. See src/api/ and src/api/flatApi.js.
  // ==========================================================================

  /**
   * `explore` namespace — scan the ontology structure and ABox collections.
   * See {@link ExploreApi}. Returns raw resources (serialization-safe).
   * @returns {ExploreApi}
   */
  get explore() {
    return this._exploreApi ??= new ExploreApi(this);
  }

  /**
   * `geo` namespace — instance-bound geospatial helpers (GeoJSON extraction,
   * sunrise/sunset). See {@link GeoApi}.
   * @returns {GeoApi}
   */
  get geo() {
    return this._geoApi ??= new GeoApi(this);
  }

  /**
   * `schema` namespace — TBox schema introspection (getSchema, sortTypesFn,
   * isArrayProperty, getGroupStrategies). See {@link SchemaApi}.
   * @returns {SchemaApi}
   */
  get schema() {
    return this._schemaApi ??= new SchemaApi(this);
  }

  /**
   * `display` namespace — UI-facing presentation helpers (labels, descriptions,
   * date formatting, resolvers, individual colors/grouping). See {@link DisplayApi}.
   * @returns {DisplayApi}
   */
  get display() {
    return this._displayApi ??= new DisplayApi(this);
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
            const shouldBeArray = await this.schema.isArrayProperty(property, { context });
            if (shouldBeArray && !Array.isArray(value)) {
              merged[property] = [value];
            }
          }
        }
      }

      try {
        return await ld.compact(merged, context, {
          ensureArrayProps: opts.ensureArrayProps !== false,
          showContext: !!opts.showContext,
          proxy: false
        });
      }
      catch (error) {
        console.error(error);
        throw error;
      }

    }

    return merged;
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

}

// Install deprecated flat-API delegates (ontologize.getLabel(), etc.) that
// forward to their namespace method. Remove in a later release once downstream
// consumers have migrated to the namespace API. See src/api/flatApi.js.
installFlatApi(Ontologize.prototype, CLIENT_FLAT_API);

// Export the class as default
export default Ontologize;
