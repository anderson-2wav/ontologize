/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check, Match } from "../lib/check.js";
import jsonPath from "../lib/jsonpath.js";
import { Query } from "../Query.js";
import { ApiNamespace } from "./ApiNamespace.js";

/**
 * `ontologize.explore` — scan the ontology structure (classes, properties,
 * ontologies) and the registered ABox collections for instance data.
 *
 * ## Raw-resource contract
 *
 * `run()` output is **designed to be serialized** — it is produced on the
 * server and returned over DDP / an HTTP API to the OntologyExplorer tangled
 * tree and TypesSelector. It therefore returns **raw resources, not LD
 * proxies**. LD proxies do not survive serialization intact: the proxy defines
 * only `get`/`set` traps (no `ownKeys`), so a serializer reads keys from the
 * raw target but values through the flattening `get` trap, silently collapsing
 * multi-valued properties to their first element and dropping `@value`/`@id`
 * wrappers. Internals below still proxy for traversal convenience; `run()`
 * unproxies the whole result at the boundary. Callers that want proxy access
 * should `ontologize.ld().proxy(resource)` themselves.
 */
export class ExploreApi extends ApiNamespace {
  /**
   * Explore the ontology structure showing classes, properties, and ontologies.
   * Scans registered collections for instance data (counts, instance properties).
   * Works on both client (Minimongo) and server (raw MongoDB collections).
   *
   * Returns **raw** resources (see the raw-resource contract on this class).
   *
   * @param {Array<object>|Array<string>} [collections] - Collections to scan for instances.
   *   Array of collection objects or name strings. If omitted, all registered collections are used.
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.recurse=true] - Whether to recurse into embedded resources
   * @param {string[]} [opts.classFilter] -
   * @returns {Promise<Object>} Explorer data with Classes, Properties, and Ontologies sections
   */
  async run(collections, opts = {}) {
    check(opts, Match.Optional(Object));

    const start = Date.now();
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

    // Step 5: Collect per-type counts via aggregation (fast path).
    // _getInstanceInfoByType is preserved for cases where field introspection
    // is also needed, but it does not scale to large ABox collections.
    const { instanceProperties, individualCounts, individualQueries, locationsCt } =
      await this._getInstanceCountsByType(resolvedCollections);

    // Step 6: Enrich instance properties with assembled bui:schema per class context.
    // Clone each propInfo before adding the type-specific schema, because the
    // ontologyCache shares objects across types and each type may produce a
    // different assembled schema for the same property.
    for (const [type, props] of Object.entries(instanceProperties)) {
      for (const [prop, propInfo] of Object.entries(props)) {
        try {
          const schema = await this.ontologize.schema.getSchema(prop, { "@type": [type] });
          if (schema && Object.keys(schema).length > 0) {
            props[prop] = { ...propInfo, "bui:schema": schema };
          }
        }
        catch (e) {
          // no schema available for this property in this class context
        }
      }
    }

    // Step 7: Get all properties grouped by type
    const allProperties = await this._getAllPropertiesGroupedByType();

    // Step 8: Get all ontology resources
    const allOntologies = await this._getAllOntologies();

    // Step 9: Build the explorer map
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
    console.log(`return explorer data in ${Math.round((Date.now() - start) / 1000)} seconds`);

    // Raw-resource contract: strip proxies so the result serializes losslessly.
    return this.ld().unproxy(ontMap);
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
      return Object.values(this.collections).filter(c => c !== this.collections["statements"]);
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
   * Reverse-map a collection object to the logical key under which it is
   * registered in this.collections. Instance queries must reference this
   * logical key — it is what clients resolve against
   * (ontologize.collections[query.collection]) — not the physical Mongo
   * collection name. The two coincide for the shared singleton but diverge
   * for private per-visitor collections (e.g. logical "species" backed by a
   * physical "species_<key>" collection). Falls back to the physical name if
   * the object isn't a registered collection.
   * @private
   * @param {object} collection
   * @returns {string}
   */
  _logicalCollectionName(collection) {
    return Object.keys(this.collections).find(k => this.collections[k] === collection)
      || collection.collectionName || collection._name || "unknown";
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
      const collectionName = this._logicalCollectionName(collection);
      const cursor = collection.find();
      const documents = cursor.toArray ? await cursor.toArray() : cursor.fetch();
      console.log(`processing ${documents.length} documents from ${collectionName}`);
      let ct = 0;
      for (const resource of documents) {
        if (!(++ct % 100)) {
          console.log(`processed ${ct} documents from ${collectionName}`);
        }
        let types = resource["@type"] ?? []; //[resource["@type"]?.[0]];

        // experiment with using the classFilter here to find all direct and subclasses of filtered types
        if (opts.classFilter) {
          const classFilter = opts.classFilter; // ['orju:SpecimenSample', 'orju:Species', 'orju:Bird'];
          const filteredTypes = [];
          classFilter.forEach((ft,ftIdx) => {
            if (types.includes(ft)) {
              const superClass = classFilter[ftIdx];
              const superClassIdx = types.indexOf(superClass);
              if (superClassIdx > -1) {
                types.forEach((type,idx) => {
                  if (idx <= superClassIdx) {
                    // console.log(`${type} subClassOf ${superClass} on ${resource._id}`);
                    filteredTypes.push(type);
                  }
                });
              }
            }
          });
          types = filteredTypes;
        }

        if (!types.length) continue;
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
            instanceProperties[type][prop] = await lookupProperty(prop);
            if (LOCATION_PROPS.includes(prop)) {
              hasLocation = true;
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
                  instanceProperties[embeddedType][prop] = await lookupProperty(prop);
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
   * Efficiently compute per-type counts and location counts using MongoDB
   * aggregation pipelines rather than iterating every document.
   *
   * Returns the same shape as _getInstanceInfoByType but with instanceProperties: {}
   * (no field introspection). Use this for large ABox collections where document-level
   * iteration would time out.
   *
   * @private
   * @param {Array} collections - resolved collection objects
   * @returns {{ instanceProperties, individualCounts, individualQueries, locationsCt }}
   */
  async _getInstanceCountsByType(collections) {
    const LOCATION_PROPS = ["geo:lat", "geo:long", "bold:spatialDepiction", "bold:spatialRange"];

    const instanceProperties = {};
    const individualCounts = {};
    const individualQueries = {};
    const locationsCt = {};

    for (const collection of collections) {
      const collectionName = this._logicalCollectionName(collection);

      // Single aggregation: unwind @type, group by type, count documents
      const rawCol = collection.rawCollection
        ? collection.rawCollection()
        : collection;

      const typeCounts = await rawCol.aggregate([
        { $unwind: { path: "$@type", preserveNullAndEmptyArrays: false } },
        { $group: { _id: "$@type", count: { $sum: 1 } } },
      ]).toArray();

      // Documents that have at least one location property, counted per type
      const locationFilter = { $or: LOCATION_PROPS.map(p => ({ [p]: { $exists: true } })) };
      const locationTypeCounts = await rawCol.aggregate([
        { $match: locationFilter },
        { $unwind: { path: "$@type", preserveNullAndEmptyArrays: false } },
        { $group: { _id: "$@type", count: { $sum: 1 } } },
      ]).toArray();

      const locationCountMap = new Map(locationTypeCounts.map(r => [r._id, r.count]));

      for (const { _id: type, count } of typeCounts) {
        individualCounts[type] = (individualCounts[type] || 0) + count;

        if (locationCountMap.has(type)) {
          locationsCt[type] = (locationsCt[type] || 0) + locationCountMap.get(type);
        }

        // Build one Query per (type, collection) pair — same structure as _getInstanceInfoByType
        if (!individualQueries[type]) individualQueries[type] = [];
        const queryName = `${type}-${collectionName}`;
        if (!individualQueries[type].find(q => q.name === queryName)) {
          individualQueries[type].push(new Query({
            name: queryName,
            collection: collectionName,
            selector: { "@type": type },
            count,
          }));
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
}

export default ExploreApi;
