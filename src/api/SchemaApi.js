/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check, Match } from "../lib/check.js";
import { ApiNamespace } from "./ApiNamespace.js";

/**
 * `ontologize.schema` — TBox schema introspection: assemble the effective
 * bui:schema for a property or class, sort types by specificity, detect
 * array-valued properties, and derive group strategies. Reads the ontology
 * collection through the owning instance (`this.ontologize._cachedOntologyLookup`,
 * `this.ontologize.getContext`).
 */
export class SchemaApi extends ApiNamespace {
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
      const globalContext = await this.ontologize.getContext();
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

      const classResource = await this.ontologize._cachedOntologyLookup(typeId, cache);

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
    const propertyDef = await this.ontologize._cachedOntologyLookup(property, cache);
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

      const classResource = await this.ontologize._cachedOntologyLookup(typ, cache);
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
            const superClassResource = await this.ontologize._cachedOntologyLookup(superClassId, cache);
            if (superClassResource) {
              await lookDeep(superClassResource);
            }
          }
        }
      }
    };

    // Walk up hierarchy from each resource type
    for (const typ of resourceTypes) {
      const classResource = await this.ontologize._cachedOntologyLookup(typ, cache);
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
}

export default SchemaApi;
