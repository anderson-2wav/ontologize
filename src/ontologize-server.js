/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { readFile, writeFile } from "fs/promises";
import { check, Match } from "./lib/check.js";
import { Ontologize } from "./ontologize.js";
import { LD } from "bold-ld";
import _ from "lodash";
import jsonPath from "./lib/jsonpath.js";

/**
 * Server-only extension of the Ontologize class
 * These methods require Node.js environment and should not be used in browser contexts
 */
export class OntologizeServer extends Ontologize {
  /**
   * Create a new OntologizeServer instance
   *
   * @param {object} ontologyCollection
   * @param {object} contextCollection
   * @param {object} [opts] - Configuration options (same as Ontologize)
   */
  constructor(ontologyCollection, contextCollection, opts = {}) {
    super(ontologyCollection, contextCollection, opts);
  }

  /**
   * Load ontology data from a file
   *
   * @param {string} filePath - Path to the ontology file
   * @returns {Promise<object>} Parsed ontology data
   */
  async loadOntologyFromFile(filePath) {
    check(filePath, String);

    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content);
    }
    catch (error) {
      throw new Error(`Failed to load ontology from ${filePath}: ${error.message}`);
    }
  }

  /**
   * Import ontology from file path with BOLD resource normalization
   * Loads JSON-LD file and imports with proper normalization using LD.compact
   *
   * @param {string} filePath - Path to JSON-LD ontology file
   * @param {object} collection - MongoDB collection to import into
   * @param {object} [opts] - Import options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ontologize=true] - Classify resources as TBox/ABox
   * @param {boolean} [opts.shareTBox=false] - Store TBox resources in both collections
   * @param {boolean} [opts.clearCollection=false] - Clear collections before importing
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.mergeOntology=true] - Merge TBox resources with existing resources using schema merge strategy
   * @returns {Promise<object>} Import result with detailed statistics
   */
  async importOntologyFromFile(filePath, collection, opts = {}) {
    check(filePath, String);
    check(collection, Object);
    check(opts, Object);

    try {
      // Load JSON-LD file
      const jsonldData = await this.loadOntologyFromFile(filePath);

      // Import the loaded data using the Context collection from this.collections
      const result = await this.importOntologyData(jsonldData, collection, opts);

      // Add file path information to result
      return {
        ...result,
        inputSource: "file",
        filePath
      };
    }
    catch (error) {
      throw new Error(`Failed to import ontology from file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Import ontology from parsed JSON-LD data with BOLD resource normalization
   * Handles multiple JSON-LD formats and uses LD.compact for proper normalization
   *
   * @param {object|Array} data - Parsed JSON-LD object or array of resources
   * @param {object} collection - MongoDB Ontology collection instance
   * @param {object} [opts] - Import options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ontologize=true] - Classify resources as TBox/ABox
   * @param {boolean} [opts.shareTBox=false] - Store TBox resources in both collections
   * @param {boolean} [opts.clearCollection=false] - Clear collections before importing
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.mergeOntology=true] - Merge TBox resources with existing resources using schema merge strategy
   * @returns {Promise<object>} Import result with detailed statistics
   */
  async importOntologyData(data, collection, opts = {}) {
    check(data, Match.OneOf(Object, Array));
    check(collection, Object);
    check(opts, Object);

    const {
      context = null,
      normalize = true,
      ontologize = true,
      shareTBox = false,
      clearCollection = false,
      ensureArrayProps = true,
      mergeOntology = true
    } = opts;

    try {
      // Step 1: Extract context and resources
      const { extractedContext, resources } = this._extractContextAndResources(data);

      // Step 2: Clear collections if requested
      if (clearCollection) {
        await Promise.all([
          collection.deleteMany({}),
          // we don't want to empty the contextCollection here
          // contextCollection.deleteMany({})
        ]);
      }

      // Step 3: Import context
      let contextImported = false;
      let contextToUse = context || extractedContext;

      if (extractedContext) {
        await this._importContext(extractedContext, this.collections.Context);
        contextImported = true;
      }

      // Step 4: Process and normalize resources
      const stats = {
        totalResources: resources.length,
        processedResources: 0,
        tboxResources: 0,
        aboxResources: 0,
        errors: []
      };

      for (const resource of resources) {
        try {
          const processed = await this._normalizeAndSaveResource(
            resource,
            contextToUse,
            collection,
            this.collections.Context,
            { normalize, ontologize, shareTBox, ensureArrayProps, mergeOntology }
          );

          if (processed) {
            stats.processedResources++;
            if (processed.isTBox) {
              stats.tboxResources++;
            }
            else {
              stats.aboxResources++;
            }
          }
        }
        catch (error) {
          stats.errors.push({
            resource: resource._id || resource["@id"] || "unknown",
            error: error.message
          });
        }
      }

      return {
        success: true,
        inputSource: "object",
        filePath: null,
        contextImported,
        ...stats
      };
    }
    catch (error) {
      throw new Error(`Failed to import ontology data: ${error.message}`);
    }
  }

  /**
   * Export collection to file path with BOLD resource normalization
   * to JSON-LD file.
   *
   * @param {string} filePath - Path to JSON-LD file
   * @param {object} collection - MongoDB collection to export from
   * @param {object} [opts] - Export options
   * @param {object} [opts.context] - JSON-LD context to use for compaction (else use default context)
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.expandUris=false] - Convert @id back to full URIs for JSON-LD
   * @returns {Promise<object>} Export result with detailed statistics
   */
  async exportToFile(filePath, collection, opts = {}) {
    check(filePath, String);
    check(collection, Object);
    check(opts, Object);

    const {
      context = null,
      normalize = true,
      ensureArrayProps = true,
      expandUris = false
    } = opts;

    try {
      // Export data from collection
      const result = await this.exportData(collection, {
        context,
        normalize,
        ensureArrayProps,
        expandUris
      });

      // Write to file
      const jsonldContent = JSON.stringify(result.data, null, 2);
      await writeFile(filePath, jsonldContent, "utf-8");

      return {
        ...result,
        outputTarget: "file",
        filePath,
        success: true
      };
    }
    catch (error) {
      throw new Error(`Failed to export to file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Export collection data with BOLD resource normalization
   *
   * @param {object} collection - MongoDB collection to export from
   * @param {object} [opts] - Export options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.expandUris=false] - Convert @id back to full URIs for JSON-LD
   * @returns {Promise<object>} Export result with data and statistics
   */
  async exportData(collection, opts = {}) {
    check(collection, Object);
    check(opts, Object);

    const {
      context = null,
      normalize = true,
      ensureArrayProps = true,
      expandUris = false
    } = opts;

    try {
      // Get all documents from collection
      const cursor = collection.find({});
      const documents = await cursor.toArray();

      // Process each document for export
      const processedResources = [];
      const stats = {
        totalResources: documents.length,
        processedResources: 0,
        errors: []
      };

      for (const doc of documents) {
        try {
          let processed = await this._prepareResourceForExport(
            doc,
            context,
            { normalize, ensureArrayProps, expandUris }
          );

          if (processed) {
            processedResources.push(processed);
            stats.processedResources++;
          }
        }
        catch (error) {
          stats.errors.push({
            resource: doc._id || doc["@id"] || "unknown",
            error: error.message
          });
        }
      }

      // Get context for output
      const contextForOutput = await this.getContext(context);

      // Create JSON-LD output structure with @context
      let data;
      if (processedResources.length === 1) {
        // Single resource with context
        data = {
          "@context": contextForOutput,
          ...processedResources[0]
        };
      }
      else {
        // Multiple resources in @graph format with context
        data = {
          "@context": contextForOutput,
          "@graph": processedResources
        };
      }

      return {
        success: true,
        outputTarget: "object",
        data,
        ...stats
      };
    }
    catch (error) {
      throw new Error(`Failed to export data: ${error.message}`);
    }
  }

  /**
   * Prepare a resource for export with BOLD normalization
   * @private
   */
  async _prepareResourceForExport(resource, context, opts = {}) {
    const {
      normalize = true,
      ensureArrayProps = true,
      expandUris = false
    } = opts;

    let processed = { ...resource };

    // Step 1: Convert _id back to @id for JSON-LD
    if (processed._id && !processed["@id"]) {
      processed["@id"] = processed._id;
      delete processed._id;
    }

    // Step 2: Ensure @type is array if needed
    if (ensureArrayProps && processed["@type"] && !Array.isArray(processed["@type"])) {
      processed["@type"] = [processed["@type"]];
    }

    // Step 3: Apply normalization if requested
    if (normalize) {
      try {
        const contextForCompaction = await this.getContext(context);
        const ld = new LD();

        // Use expand first if we want full URIs, then compact
        if (expandUris) {
          const expanded = await ld.expand(processed, contextForCompaction);
          processed = expanded[0] || processed;
        }
        else {
          // Regular compaction for BOLD format
          const compacted = await ld.compact(processed, contextForCompaction, {
            ensureArrayProps: ensureArrayProps,
            ensureSafeKeys: false, // We want JSON-LD output, not MongoDB-safe keys
            showContext: false,
            proxy: false
          });

          // Handle the case where compact returns an array or @graph
          if (Array.isArray(compacted)) {
            processed = compacted[0] || processed;
          }
          else if (compacted["@graph"]) {
            processed = compacted["@graph"][0] || processed;
          }
          else {
            processed = compacted;
          }
        }
      }
      catch (error) {
        console.warn(`Failed to process resource ${resource._id || resource["@id"]} for export: ${error.message}`);
      }
    }

    return processed;
  }

  /**
   * Determine if a resource is a TBox (ontology) resource
   * @private
   */
  _isTBoxResource(resource) {
    if (!resource["@type"]) {
      return false;
    }

    const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];
    const ontologyTypes = [
      "owl:Class", "rdfs:Class",
      "owl:ObjectProperty", "owl:DatatypeProperty", "owl:AnnotationProperty", "rdf:Property",
      "owl:Ontology", "owl:Restriction"
    ];

    return types.some(type => ontologyTypes.includes(type));
  }

  /**
   * Extract context and resources from JSON-LD input
   * Handles both @graph format and array format
   * Merges all contexts found in array items like CTB Ontology.importContext
   * @private
   */
  _extractContextAndResources(jsonldData) {
    let extractedContext = null;
    let resources = [];

    if (Array.isArray(jsonldData)) {
      // Array format - collect all contexts and merge them
      const foundContexts = [];

      for (const item of jsonldData) {
        if (item["@context"]) {
          foundContexts.push(item["@context"]);
        }
        else {
          resources.push(item);
        }
      }

      // Merge all found contexts using the same strategy as _importContext
      if (foundContexts.length > 0) {
        extractedContext = {};
        for (const contextData of foundContexts) {
          extractedContext = _.assignWith(extractedContext, contextData, this._contextAssignCustomizer.bind(this));
        }
      }
    }
    else if (jsonldData["@graph"]) {
      // @graph format
      extractedContext = jsonldData["@context"] || null;
      resources = jsonldData["@graph"] || [];
    }
    else {
      // Single resource
      resources = [jsonldData];
    }

    return { extractedContext, resources };
  }

  /**
   * Import context into Context collection with sophisticated merge strategy
   * Merges new context data with existing context using specialized conflict resolution
   * In BOLD, the context document contains the context data directly (no nested @context)
   * @private
   */
  async _importContext(contextData, contextCollection) {
    check(contextData, Object);

    // Get existing context from the Context collection
    let existingContextDoc = await contextCollection.findOne({ _id: "@id" });
    let existingContext = {};

    // Extract existing context data (excluding _id)
    if (existingContextDoc) {
      existingContext = { ...existingContextDoc };
      delete existingContext._id;
    }

    // Merge the contexts using specialized merge strategy
    const mergedContext = _.assignWith(existingContext, contextData, this._contextAssignCustomizer);

    // Sort context keys for consistent ordering
    const sortedContext = this._sortContextKeys(mergedContext);

    // Update the context document with merged context data directly
    await contextCollection.replaceOne(
      { _id: "@id" },
      { _id: "@id", ...sortedContext },
      { upsert: true }
    );
  }


  /**
   * Process a single resource with BOLD normalization using LD.compact
   * @private
   */
  async _normalizeAndSaveResource(resource, context, collection, contextCollection, opts) {
    const {
      normalize = true,
      ontologize = true,
      shareTBox = false,
      ensureArrayProps = true,
      mergeOntology = true
    } = opts;
    const ontologyCollection = this.collections.Ontology;
    let processedResource = { ...resource };
    let isTBoxResource = false;

    // Step 1: Normalize resource using LD.compact if requested
    if (normalize) {
      // Get context for compaction (provided, from Context collection, or default)
      const contextForCompaction = await this.getContext(context);
      try {
        const ld = new LD();
        const compacted = await ld.compact(processedResource, contextForCompaction, {
          ensureArrayProps: ensureArrayProps,
          ensureSafeKeys: true,
          showContext: false,
          proxy: false // this is important! so that we don't persist the proxy-modified content
        });

        // Handle the case where compact returns an array or @graph
        if (Array.isArray(compacted)) {
          processedResource = compacted[0] || processedResource;
        }
        else if (compacted["@graph"]) {
          processedResource = compacted["@graph"][0] || processedResource;
        }
        else {
          processedResource = compacted;
        }
      }
      catch (error) {
        console.warn(`Failed to compact resource ${resource._id || resource["@id"]}: ${error.message}`);
      }
    }

    // Step 2: Ensure @type is array. This _should be
    if (ensureArrayProps && processedResource["@type"] && !Array.isArray(processedResource["@type"])) {
      processedResource["@type"] = [processedResource["@type"]];
    }

    // Step 3: Convert @id to _id for MongoDB storage
    if (processedResource["@id"] && !processedResource._id) {
      processedResource._id = processedResource["@id"];
      delete processedResource["@id"];
    }

    // Step 4: Validate that resource has an identifier
    if (!processedResource._id) {
      throw new Error("Resource must have _id or @id for MongoDB storage");
    }

    // Step 5: Classify as TBox/ABox resource
    if (ontologize) {
      isTBoxResource = this._isTBoxResource(processedResource);
    }

    // Step 6: Save to appropriate collection(s)
    if (isTBoxResource) {
      // TBox resource - save to Ontology collection with merge strategy.
      await this._saveResourceWithMerge(processedResource, ontologyCollection, { mergeOntology });

      // Also save to main collection if shareTBox is true,
      // But not if the collection we're importing into is the ontologyCollection,
      // cause we already did that above.
      if (shareTBox && collection !== ontologyCollection) {
        await collection.replaceOne(
          { _id: processedResource._id },
          processedResource,
          { upsert: true }
        );
      }
    }
    else {
      // ABox resource - save to main collection
      await collection.replaceOne(
        { _id: processedResource._id },
        processedResource,
        { upsert: true }
      );
    }

    return {
      success: true,
      isTBox: isTBoxResource,
      resource: processedResource
    };
  }

  /**
   * Customizer function for merging context objects with specialized conflict resolution
   * Handles namespace conflicts intelligently based on BOLD/CTB patterns
   * @private
   */
  _contextAssignCustomizer(objValue, srcValue, key) {
    // If original objValue exists and is different from new srcValue, we have a conflict
    if (objValue && !_.isEqual(objValue, srcValue)) {
      // Handle specific known namespace conflicts
      if (key === "dc" && srcValue === "http://purl.org/dc/elements/1.1/") {
        console.warn(`Context conflict for ${key}, old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}. Using new value.`);
        return undefined; // Let lodash use the new value
      }

      if (key === "ctb" && srcValue === "https://ontology.2wav.com/bridge#") {
        console.warn(`Context conflict for ${key}, old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}. Keeping existing value.`);
        return objValue; // Keep the existing value
      }

      if (key === "dcterms") {
        console.warn(`Context conflict for ${key}, old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}. Using canonical value.`);
        return "http://purl.org/dc/terms/"; // Use canonical value
      }

      // BOLD namespace handling - prefer BOLD over CTB
      if (key === "bold" || (key === "ctb" && srcValue.includes("bold"))) {
        console.warn(`Context conflict for ${key}, preferring BOLD namespace. old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}`);
        return srcValue; // Prefer BOLD namespace
      }

      // If both are objects, merge them recursively
      if (_.isObject(objValue) && _.isObject(srcValue)) {
        const merged = _.mergeWith(objValue, srcValue, this._schemaMergeCustomizer);
        console.warn(`Context conflict for ${key}, merging objects. old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)} result=${JSON.stringify(merged)}`);
        return merged;
      }

      // For any other conflicting combination, throw an error
      throw new Error(`Namespace conflict for ${key}: existing=${JSON.stringify(objValue)} vs new=${JSON.stringify(srcValue)}`);
    }

    // No conflict, let lodash handle the default assignment
    return undefined;
  }

  /**
   * Schema merge customizer for handling array merging in contexts
   * Ensures arrays are properly merged using union to avoid duplicates
   * @private
   */
  _schemaMergeCustomizer(objValue, srcValue, _key, _object, _source, _stack) {
    // Ensure we merge arrays from either side
    if (_.isArray(objValue) || _.isArray(srcValue)) {
      // Handle null/undefined values
      if (objValue === null || objValue === undefined) {
        objValue = [];
      }
      if (srcValue === null || srcValue === undefined) {
        srcValue = [];
      }

      // Convert non-arrays to arrays when one side is an array
      if (!_.isArray(objValue)) {
        objValue = [objValue];
      }
      if (!_.isArray(srcValue)) {
        srcValue = [srcValue];
      }

      // Use union to merge arrays and remove duplicates
      return _.union(objValue, srcValue);
    }

    // For non-arrays, let lodash use default behavior
    return undefined;
  }

  /**
   * Save a resource to a collection with intelligent merge strategy
   * Similar to CTB Ontology.updateOntology, merges with existing resources to preserve data
   * @private
   */
  async _saveResourceWithMerge(resource, collection, opts = {}) {
    const { mergeOntology = true } = opts;
    check(resource, Object);
    check(collection, Object);

    if (!resource._id) {
      throw new Error("Resource must have _id for MongoDB storage");
    }

    // Check if a resource with this _id already exists
    const existingResource = await collection.findOne({ _id: resource._id });

    if (existingResource && mergeOntology) {
      // Merge existing resource with new resource using schema merge strategy
      // Clone the existing resource to avoid modifying the original
      const mergedResource = _.mergeWith(_.cloneDeep(existingResource), resource, this._schemaMergeCustomizer.bind(this));

      // Update the existing resource with merged data
      await collection.replaceOne(
        { _id: resource._id },
        mergedResource,
        { upsert: true }
      );
    }
    else {
      // Either no existing resource, or mergeOntology is false - just replace
      await collection.replaceOne(
        { _id: resource._id },
        resource,
        { upsert: true }
      );
    }
  }

  /**
   * Sort context keys for consistent ordering
   * Places @-prefixed keys first, then namespaces (no colon), then prefixed terms
   * @private
   */
  _sortContextKeys(context) {
    const sortedKeys = Object.keys(context).sort((a, b) => {
      // Check if keys are namespace declarations (no colon)
      const aNamespace = !a.includes(":");
      const bNamespace = !b.includes(":");

      // Namespaces sort before prefixed terms
      if (aNamespace !== bNamespace) {
        return aNamespace ? -1 : 1;
      }

      // @-prefixed keys (like @vocab, @base) sort to the front
      if (a[0] === "@" && b[0] !== "@") {
        return -1;
      }
      if (b[0] === "@" && a[0] !== "@") {
        return 1;
      }

      // Standard lexical sorting
      return a.localeCompare(b);
    });

    // Rebuild the context object with sorted keys
    const sortedContext = {};
    for (const key of sortedKeys) {
      sortedContext[key] = context[key];
    }

    return sortedContext;
  }

  /**
   * Create a JSON object that maps the ontology showing all @types and their properties
   * found across collections, similar to CTB Ontology.explorer()
   *
   * @param {Array<object>} collections - Array of MongoDB collection instances to analyze
   * @param {object} [opts] - Options for exploration
   * @param {boolean} [opts.recurse=true] - Whether to recurse into embedded resources
   * @returns {object} Explorer map with README and @types mapped to their properties
   */
  async explorer(collections, opts = {}) {
    check(collections, Array);
    check(opts, Match.Optional(Object));

    opts.recurse = opts.recurse !== false;

    const ontMap = {};
    ontMap.README = `This is a JSON map of all Resource top-level @types found in BOLD. Within each top-level type, are all of the properties found on any resource of that type. Each property includes its ontology resource. The @type property shows each @type found on those Resources, including super-types.`;

    for (const collection of collections) {
      // Get collection name - try different ways to access it
      const collectionName = collection.collectionName || collection._name || "unknown";

      const cursor = collection.find();
      const documents = await cursor.toArray();

      for (const resource of documents) {
        let type = this._first(resource["@type"]);
        if (type === undefined) {
          type = collectionName + " unknown type";
        }

        ontMap[type] = ontMap[type] || {};

        if (opts.recurse && collectionName !== "bridge" && collectionName !== "statements") {
          const embeddedResources = [];
          const paths = jsonPath(resource, "$..*['@type']", { resultType: "PATH" });

          if (paths) {
            for (const path of paths) {
              // Skip @context paths
              if (path.indexOf("@context") !== -1) {
                continue;
              }
              if (path === "$['@type']") {
                continue;
              }

              // Path less the $ start and the ['@type'] leaf element
              const parentPath = path.substring(1, path.length - "['@type']".length);
              const embeddedResource = _.get(resource, parentPath);

              if (embeddedResource) {
                // Skip embedded Statements
                if (!this._is(embeddedResource, "rdf:Statement")) {
                  embeddedResources.push(embeddedResource);
                }
              }
            }

            for (const _resource of embeddedResources) {
              const _type = this._first(_resource["@type"]);
              if (!_type) {
                continue;
              }

              ontMap[_type] = ontMap[_type] || {};
              for (const _prop in _resource) {
                await this._mapOneProp(_type, _resource, _prop, ontMap);
              }
            }
          }
        }

        for (const prop in resource) {
          await this._mapOneProp(type, resource, prop, ontMap);
        }
      }
    }

    return ontMap;
  }

  /**
   * Helper function to get the first element of an array or return the value if not an array
   * Equivalent to CTB's first() function
   * @private
   */
  _first(arrayOrVal) {
    if (Array.isArray(arrayOrVal)) {
      if (arrayOrVal.length) {
        return arrayOrVal[0];
      }
      return undefined;
    }
    return arrayOrVal;
  }

  /**
   * Helper function to check if a resource has a specific @type
   * Equivalent to CTB's is() function
   * @private
   */
  _is(resArrayOrVal, typ) {
    typ = Array.isArray(typ) ? typ : [typ];

    if (_.isObjectLike(resArrayOrVal)) {  // i.e., not null
      if (resArrayOrVal["@type"]) {
        resArrayOrVal = resArrayOrVal["@type"];
      }
    }

    resArrayOrVal = Array.isArray(resArrayOrVal) ? resArrayOrVal : [resArrayOrVal];
    return !!_.intersection(resArrayOrVal, typ).length;
  }

  /**
   * Helper function to map one property in the ontology explorer
   * @private
   */
  async _mapOneProp(type, resource, prop, ontMap) {
    if (prop === "@type") {
      ontMap[type]["@type"] = ontMap[type]["@type"] || {};
      const types = ontMap[type]["@type"];
      const resourceTypes = _.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];

      for (const typ of resourceTypes) {
        if (types[typ]) {
          continue;
        }
        // Try to find ontology information from the Ontology collection
        const ontResource = await this.collections.Ontology.findOne({ _id: typ });
        types[typ] = ontResource || {};
      }
      return;
    }

    // Try to find ontology information for this property
    const ontResource = await this.collections.Ontology.findOne({ _id: prop });
    ontMap[type][prop] = ontResource || {};
  }
}

// Export the extended class as default
export default OntologizeServer;
