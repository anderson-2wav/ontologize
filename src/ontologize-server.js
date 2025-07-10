/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { readFile } from "fs/promises";
import { check, Match } from "./lib/check.js";
import { Ontologize } from "./ontologize.js";
import { LD } from "ld";

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
   * @param {object} ontologyCollection - MongoDB Ontology collection instance
   * @param {object} contextCollection - MongoDB Context collection instance
   * @param {object} [opts] - Import options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ontologize=true] - Classify resources as TBox/ABox
   * @param {boolean} [opts.shareTBox=false] - Store TBox resources in both collections
   * @param {boolean} [opts.clearCollections=false] - Clear collections before importing
   * @param {boolean} [opts.ensureArrayTypes=true] - Ensure @type is always an array
   * @returns {Promise<object>} Import result with detailed statistics
   */
  async importOntologyFromFile(filePath, ontologyCollection, contextCollection, opts = {}) {
    check(filePath, String);
    check(ontologyCollection, Object);
    check(contextCollection, Object);
    check(opts, Object);

    try {
      // Load JSON-LD file
      const jsonldData = await this.loadOntologyFromFile(filePath);

      // Import the loaded data
      const result = await this.importOntologyData(jsonldData, ontologyCollection, contextCollection, opts);

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
   * @param {object} contextCollection - MongoDB Context collection instance
   * @param {object} [opts] - Import options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ontologize=true] - Classify resources as TBox/ABox
   * @param {boolean} [opts.shareTBox=false] - Store TBox resources in both collections
   * @param {boolean} [opts.clearCollections=false] - Clear collections before importing
   * @param {boolean} [opts.ensureArrayTypes=true] - Ensure @type is always an array
   * @returns {Promise<object>} Import result with detailed statistics
   */
  async importOntologyData(data, collection, contextCollection, opts = {}) {
    check(data, Match.OneOf(Object, Array));
    check(collection, Object);
    check(contextCollection, Object);
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
        await this._importContext(extractedContext, contextCollection);
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
            contextCollection,
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
   * Import context into Context collection with BOLD normalization
   * @private
   */
  async _importContext(contextData, contextCollection) {
    const contextResource = {
      _id: "@context",
      ...contextData
    };

    await contextCollection.replaceOne(
      { _id: "@context" },
      contextResource,
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
}

// Export the extended class as default
export default OntologizeServer;
