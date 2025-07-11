/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { readFile } from "fs/promises";
import { check, Match } from "./lib/check.js";
import { Ontologize } from "./ontologize.js";
import { LD } from "ld";
import _ from "lodash";

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
   * @param {boolean} [opts.clearCollections=false] - Clear collections before importing
   * @param {boolean} [opts.ensureArrayTypes=true] - Ensure @type is always an array
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
   * @param {boolean} [opts.clearCollections=false] - Clear collections before importing
   * @param {boolean} [opts.ensureArrayTypes=true] - Ensure @type is always an array
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
      clearCollections = false,
      ensureArrayTypes = true
    } = opts;

    try {
      // Step 1: Extract context and resources
      const { extractedContext, resources } = this._extractContextAndResources(data);

      // Step 2: Clear collections if requested
      if (clearCollections) {
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
          const processed = await this._normalizeResource(
            resource,
            contextToUse,
            collection,
            this.collections.Context,
            { normalize, ontologize, shareTBox, ensureArrayTypes }
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
   * @private
   */
  _extractContextAndResources(jsonldData) {
    let extractedContext = null;
    let resources = [];

    if (Array.isArray(jsonldData)) {
      // Array format - first element might be context
      for (const item of jsonldData) {
        if (item._id === "@context" && item["@context"]) {
          extractedContext = item["@context"];
        }
        else {
          resources.push(item);
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
    let existingContextDoc = await contextCollection.findOne({ _id: "@context" });
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
      { _id: "@context" },
      { _id: "@context", ...sortedContext },
      { upsert: true }
    );
  }

  /**
   * Process a single resource with BOLD normalization using LD.compact
   * @private
   */
  async _normalizeResource(resource, context, ontologyCollection, contextCollection, opts) {
    const { normalize = true, ontologize = true, shareTBox = false, ensureArrayTypes = true } = opts;

    let processedResource = { ...resource };
    let isTBoxResource = false;

    // Step 1: Normalize resource using LD.compact if requested
    if (normalize && context) {
      try {
        const ld = new LD();
        const compacted = await ld.compact(processedResource, context, {
          ensureArrayProps: ensureArrayTypes,
          ensureSafeKeys: true,
          showContext: false
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

    // Step 2: Ensure @type is array if ensureArrayTypes is true
    if (ensureArrayTypes && processedResource["@type"] && !Array.isArray(processedResource["@type"])) {
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
      // Save to Ontology collection
      await ontologyCollection.replaceOne(
        { _id: processedResource._id },
        processedResource,
        { upsert: true }
      );

      // Also save to main collection if shareTBox is true
      if (shareTBox) {
        await ontologyCollection.replaceOne(
          { _id: processedResource._id },
          processedResource,
          { upsert: true }
        );
      }
    }
    else {
      // ABox resource - save to main collection
      await ontologyCollection.replaceOne(
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
  _schemaMergeCustomizer(objValue, srcValue, key, object, source, stack) {
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
}

// Export the extended class as default
export default OntologizeServer;
