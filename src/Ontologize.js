/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { check, Match } from "./lib/check.js";
import jsonPath from "./lib/jsonpath.js";
import LD from "bold-ld";

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
   */
  constructor(ontologyCollection, contextCollection, statementsCollection, opts = {}) {
    check(ontologyCollection, Object);
    check(contextCollection, Object);
    check(statementsCollection, Object);

    this.collections = {
      Ontology: ontologyCollection,
      Context: contextCollection,
      Statements: statementsCollection
    };

    this.opts = opts;
    this.opts.defaultContext = this.opts.defaultContext || Ontologize.DEFAULT_CONTEXT;
    this.opts.debug = this.opts.debug || false;
    this.opts.labelProperties = this.opts.labelProperties || Ontologize.DEFAULT_LABEL_PROPERTIES;
    this.opts.descriptionProperties = this.opts.descriptionProperties || Ontologize.DEFAULT_DESCRIPTION_PROPERTIES;
    if (this.opts.collections) {
      Object.assign(this.collections, this.opts.collections);
    }
    this.version = "0.1.0";

    // Initialize singleton LD instance for this Ontologize instance
    this._ld = null;
    // TODO THERE ARE REAL PROBLEMS WITH CLIENT/SERVER HERE
    // on Meteor client, findOne returns resource,
    // on server, returns promise
    const wat = this.collections.Context.findOne({ _id: "@id" });
    if (wat instanceof Promise) {
      wat.then((context) => {
        const ld = new LD({ context });
        this._ld = ld;
      });
    }
    else if (wat) {
      const ld = new LD({ context: wat });
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
   * @param {string} [fallback] - Fallback if no label found
   * @returns {Promise<string>} The label or fallback
   */
  async getLabel(resource, property, fallback) {
    check(resource, Object);
    check(property, Match.Optional(String));
    check(fallback, Match.Optional(String));

    // Get the assembled schema to check for label or labelProperties override
    const schema = await this.getSchema(property, resource);
    // if there is a direct label override, use it
    if (schema.label) {
      return schema.label;
    }
    const labelProperties = schema?.labelProperties || this.opts.labelProperties;

    // which thing to examine, the resource or the property resource?
    let examineResource = resource;
    // if property was provided, then we want the property resource, not the resource
    if (property) {
      examineResource = await this.collections.Ontology.findOne({_id: property});
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
      // Try to extract a readable name from the ID
      const id = resource[_id];
      const parts = id.split(/[#/:]/);
      return parts[parts.length - 1];
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
      const rawResource = await this.collections.Ontology.findOne({ _id: resourceId });
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
      const contextDoc = await this.collections.Context.findOne({ _id: "@id" });
      if (contextDoc) {
        // TODO why do we do that? I think _id: "@id" is part of the context
        // Extract context data (excluding _id)
        // const { _id, ...contextData } = contextDoc;

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
        const rawResource = await this.collections.Ontology.findOne({ _id: propertyId });
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
        const LD = await import("bold-ld").then(m => m.LD);
        const ld = new LD();
        const context = opts.context || await this.getContext();
        return await ld.compact(resource, context, {
          ensureArrayProps: opts.ensureArrayProps !== false,
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

          // Store as array if multiple values, single value if only one
          merged[property] = mergedArray.length === 1 ? mergedArray[0] : mergedArray;
        }
      }
    }

    // Compact the merged resource if requested
    if (opts.compact !== false) {
      const LD = await import("bold-ld").then(m => m.LD);
      const ld = new LD();
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
        const cursor = this.collections.Ontology.find({
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
   * @returns {Promise<Object>} The merged bui:schema object, or empty object if none found
   */
  async getSchema(property, resource) {
    check(property, Match.Optional(String));
    check(resource, Match.Optional(Object));

    // Class schema mode: no property provided, but resource is
    if (!property && resource) {
      return this._getClassSchema(resource);
    }

    // Property schema mode (original behavior)
    if (!property) {
      return {};
    }

    const schemas = await this._findSchemasWithProperty(resource, property, "bui:schema");
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
   * @returns {Promise<Object>} The merged class schema, or empty object if none found
   * @private
   */
  async _getClassSchema(resource) {
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

      const rawClassResource = await this.collections.Ontology.findOne({ _id: typeId });
      const classResource = rawClassResource ? this.ld().proxy(rawClassResource) : null;

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
   * @returns {Promise<Object[]>} Array of ontology resources with the specified property
   * @private
   */
  async _findSchemasWithProperty(resource, property, ontologyProperty) {
    check(resource, Match.Optional(Object));
    check(property, String);
    check(ontologyProperty, String);

    const foundSchemas = [];
    const exploredTypes = new Set();

    // First, check if the property itself has the ontology property
    const rawPropertyDef = await this.collections.Ontology.findOne({ _id: property });
    const propertyDef = rawPropertyDef ? this.ld().proxy(rawPropertyDef) : null;
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

      const rawClassResource = await this.collections.Ontology.findOne({ _id: typ });
      const classResource = rawClassResource ? this.ld().proxy(rawClassResource) : null;
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
            const rawSuperClassResource = await this.collections.Ontology.findOne({ _id: superClassId });
            const superClassResource = rawSuperClassResource ? this.ld().proxy(rawSuperClassResource) : null;
            if (superClassResource) {
              await lookDeep(superClassResource);
            }
          }
        }
      }
    };

    // Walk up hierarchy from each resource type
    for (const typ of resourceTypes) {
      const rawClassResource = await this.collections.Ontology.findOne({ _id: typ });
      const classResource = rawClassResource ? this.ld().proxy(rawClassResource) : null;
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

      const rawClassResource = await this.collections.Ontology.findOne({ _id: typ });
      const classResource = rawClassResource ? this.ld().proxy(rawClassResource) : null;
      if (classResource) {
        foundOntology.push(classResource);
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
              const rawSuperClassResource = await this.collections.Ontology.findOne({ _id: superClassId });
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
   * Get module version
   *
   * @returns {string} The module version
   */
  getVersion() {
    return this.version;
  }

  static DEFAULT_CONTEXT = {
    "@vocab" : "https://ontology.2wav.com#",
    "rdf" : "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs" : "http://www.w3.org/2000/01/rdf-schema#",
    "owl" : "http://www.w3.org/2002/07/owl#",
    "xsd" : "http://www.w3.org/2001/XMLSchema#",
    "foaf" : "http://xmlns.com/foaf/0.1/",
    "dc" : "http://purl.org/dc/elements/1.1/",
    "org" : "http://www.w3.org/ns/org#",
    "uo" : "http://purl.obolibrary.org/obo/uo.owl",
    "xbfo" : "http://purl.obolibrary.org/obo/bfo.owl",
    "obo" : "http://purl.obolibrary.org/obo/",
    "2wav" : "https://ontology.2wav.com#",
    "2do" : "https://ontology.2wav.com/display#",
    "bfo" : "https://ontology.2wav.com/bfo#",
    "ctb" : "https://ontology.2wav.com/bridge#",
    "ctl" : "https://ontology.2wav.com/800-53#",
    "ctl5" : "https://ontology.2wav.com/800-53/rev5#",
    "nice" : "https://ontology.2wav.com/nice#",
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
      "@type" : "@id"
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
   * This is the client/server compatible version that only uses the Ontology collection.
   *
   * @param {Object} [opts] - Options
   * @returns {Promise<Object>} Explorer data with Classes, Properties, and Ontologies sections
   */
  async explorer(opts = {}) {
    check(opts, Match.Optional(Object));

    // Step 1: Get all classes from the ontology
    const allClasses = await this._getAllClassesFromOntology();

    // Step 2: Order classes by specificity (least to most specific)
    const orderedClasses = await this._orderClassesBySpecificity(allClasses);

    // Step 3: For each class, get properties with this class as rdfs:domain
    const domainProperties = await this._getPropertiesByDomain();

    // Step 4: Get all properties grouped by type
    const allProperties = await this._getAllPropertiesGroupedByType();

    // Step 5: Get all ontology resources
    const allOntologies = await this._getAllOntologies();

    // Step 6: Build the explorer map
    const ontMap = {};
    ontMap.README = "This is a JSON map of the ontology structure. Classes are ordered from least to most specific, showing domain properties. Properties are grouped by ObjectProperties, DatatypeProperties, and general Properties. Ontologies shows loaded ontology definitions.";

    // Classes section
    ontMap.Classes = {};
    for (const className of orderedClasses) {
      const classInfo = allClasses[className] || {};

      ontMap.Classes[className] = {
        classInfo: classInfo,
        domainProperties: domainProperties[className] || {}
      };
    }

    // Properties section
    ontMap.Properties = allProperties;

    // Ontologies section
    ontMap.Ontologies = allOntologies;

    return ontMap;
  }

  /**
   * Get all classes from the ontology collection
   * @private
   */
  async _getAllClassesFromOntology() {
    const classes = {};
    const cursor = this.collections.Ontology.find({
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
   * Order classes by specificity using rdfs:subClassOf relationships.
   * Returns array of class names ordered from least to most specific, with blank nodes at the end.
   * @private
   */
  async _orderClassesBySpecificity(allClasses) {
    const classNames = Object.keys(allClasses);
    const subClassMap = {};

    // Separate blank nodes from named classes
    const namedClasses = classNames.filter(name => !this._isBlankNodeId(name));
    const blankNodes = classNames.filter(name => this._isBlankNodeId(name));

    // Build subclass relationships for named classes only
    for (const className of namedClasses) {
      const classResource = allClasses[className];
      const subClassOf = classResource["rdfs:subClassOf"];

      if (subClassOf) {
        const parents = Array.isArray(subClassOf) ? subClassOf : [subClassOf];
        subClassMap[className] = parents.map(parent =>
          typeof parent === "object" ? parent["@id"] || parent._id : parent
        ).filter(parent => parent && namedClasses.includes(parent));
      }
      else {
        subClassMap[className] = [];
      }
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
    const cursor = this.collections.Ontology.find({
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

    const cursor = this.collections.Ontology.find({
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
    const cursor = this.collections.Ontology.find({
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
}

// Export the class as default
export default Ontologize;
