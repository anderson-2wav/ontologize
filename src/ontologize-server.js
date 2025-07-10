/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { readFile, readdir } from "fs/promises";
import { join } from "path";
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
   * @param {object} [opts] - Configuration options (same as Ontologize)
   */
  constructor(opts = {}) {
    super(opts);
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
   * Load multiple ontology files from a directory
   *
   * @param {string} dirPath - Path to directory containing ontology files
   * @param {string} [extension=".json"] - File extension to filter by
   * @returns {Promise<Array>} Array of loaded ontology resources
   */
  async loadOntologiesFromDirectory(dirPath, extension = ".json") {
    check(dirPath, String);
    check(extension, String);

    try {
      const files = await readdir(dirPath);
      const ontologyFiles = files.filter(file => file.endsWith(extension));

      const ontologies = [];
      for (const file of ontologyFiles) {
        const filePath = join(dirPath, file);
        try {
          const ontology = await this.loadOntologyFromFile(filePath);
          ontologies.push(ontology);
        }
        catch (error) {
          console.warn(`Failed to load ontology from ${filePath}: ${error.message}`);
        }
      }

      return ontologies;
    }
    catch (error) {
      throw new Error(`Failed to load ontologies from directory ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Save resources to MongoDB collection
   *
   * @param {object} collection - MongoDB collection instance
   * @param {Array|object} resources - Resources to save
   * @param {object} [opts] - Options
   * @param {boolean} [opts.upsert=true] - Use upsert operation
   * @param {boolean} [opts.clearCollection=false] - Clear collection before inserting
   * @returns {Promise<object>} Result of the operation
   */
  async saveToCollection(collection, resources, opts = {}) {
    check(collection, Object);
    check(resources, Match.OneOf(Object, Array));
    check(opts, Object);

    const { upsert = true, clearCollection = false } = opts;

    try {
      if (clearCollection) {
        await collection.deleteMany({});
      }

      const resourceArray = Array.isArray(resources) ? resources : [resources];
      const results = [];

      for (const resource of resourceArray) {
        if (!resource["@id"]) {
          throw new Error("Resource must have @id for MongoDB storage");
        }

        if (upsert) {
          const result = await collection.replaceOne(
            { "@id": resource["@id"] },
            resource,
            { upsert: true }
          );
          results.push(result);
        }
        else {
          const result = await collection.insertOne(resource);
          results.push(result);
        }
      }

      return {
        success: true,
        count: results.length,
        results
      };
    }
    catch (error) {
      throw new Error(`Failed to save to MongoDB: ${error.message}`);
    }
  }

  /**
   * Import ontology data from file and save to MongoDB
   *
   * @param {string} filePath - Path to ontology file
   * @param {object} collection - MongoDB collection instance
   * @param {object} [opts] - Options
   * @param {boolean} [opts.upsert=true] - Use upsert operation
   * @param {boolean} [opts.clearCollection=false] - Clear collection before importing
   * @returns {Promise<object>} Import result
   */
  async importOntology(filePath, collection, opts = {}) {
    check(filePath, String);
    check(collection, Object);
    check(opts, Object);

    try {
      const ontologyData = await this.loadOntologyFromFile(filePath);
      const result = await this.saveToCollection(collection, ontologyData, opts);

      return {
        success: true,
        filePath,
        ...result
      };
    }
    catch (error) {
      throw new Error(`Failed to import ontology from ${filePath}: ${error.message}`);
    }
  }

  /**
   * Query MongoDB for ontology resources
   *
   * @param {object} collection - MongoDB collection instance
   * @param {object} query - MongoDB query
   * @param {object} [opts] - Query options
   * @returns {Promise<Array>} Array of matching resources
   */
  async queryMongoDB(collection, query, opts = {}) {
    check(collection, Object);
    check(query, Object);
    check(opts, Object);

    try {
      const cursor = collection.find(query, opts);
      return await cursor.toArray();
    }
    catch (error) {
      throw new Error(`Failed to query MongoDB: ${error.message}`);
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
  async importOntologyData(data, ontologyCollection, contextCollection, opts = {}) {
    check(data, Match.OneOf(Object, Array));
    check(ontologyCollection, Object);
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
          ontologyCollection.deleteMany({}),
          contextCollection.deleteMany({})
        ]);
      }

      // Step 3: Import context
      let contextImported = false;
      let contextToUse = context || extractedContext;

      if (extractedContext) {
        await this._importBOLDContext(extractedContext, contextCollection);
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
          const processed = await this._processBOLDResource(
            resource,
            contextToUse,
            ontologyCollection,
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
   * Legacy comprehensive JSON-LD import method
   * @deprecated Use importOntologyFromFile or importOntologyData instead
   * @param {string|object|Array} input - File path, parsed JSON-LD object, or array of resources
   * @param {object} ontologyCollection - MongoDB Ontology collection instance
   * @param {object} contextCollection - MongoDB Context collection instance
   * @param {object} [opts] - Import options
   * @returns {Promise<object>} Import result with detailed statistics
   */
  async importBOLDResources(input, ontologyCollection, contextCollection, opts = {}) {
    check(input, Match.OneOf(String, Object, Array));

    if (typeof input === "string") {
      return await this.importOntologyFromFile(input, ontologyCollection, contextCollection, opts);
    }
    else {
      return await this.importOntologyData(input, ontologyCollection, contextCollection, opts);
    }
  }

  /**
   * Legacy method - Import ontology data from JSON-LD file into collections
   * @deprecated Use importOntologyFromFile for better normalization and flexibility
   * @param {string} filePath - Path to JSON-LD ontology file
   * @param {object} ontologyCollection - MongoDB Ontology collection instance
   * @param {object} contextCollection - MongoDB Context collection instance
   * @param {object} [opts] - Import options
   * @param {boolean} [opts.ontologize=true] - Determine if resources are TBox resources
   * @param {boolean} [opts.shareTBox=false] - Persist TBox resources to param collection
   * @param {boolean} [opts.clearCollections=false] - Clear collections before importing
   * @returns {Promise<object>} Import result with counts
   */
  async _legacyImportOntologyFromFile(filePath, ontologyCollection, contextCollection, opts = {}) {
    check(filePath, String);
    check(ontologyCollection, Object);
    check(contextCollection, Object);
    check(opts, Object);

    const { ontologize = true, shareTBox = false, clearCollections = false } = opts;

    try {
      // Load and parse the JSON-LD file
      const fileData = await this.loadOntologyFromFile(filePath);

      if (!Array.isArray(fileData)) {
        // Handle @graph format
        if (fileData["@graph"]) {
          if (fileData["@context"]) {
            // Import context to Context collection
            await this._importContext(fileData["@context"], contextCollection);
          }

          let resourcesProcessed = 0;
          for (const resource of fileData["@graph"]) {
            const processed = await this._processResource(resource, ontologyCollection, contextCollection, opts);
            if (processed) {
              resourcesProcessed++;
            }
          }

          return {
            success: true,
            filePath,
            contextImported: !!fileData["@context"],
            resourcesProcessed,
            totalResources: fileData["@graph"].length
          };
        }
        else {
          throw new Error("Expected array or object with @graph property");
        }
      }

      // Handle array format - first element might be context
      const resources = [...fileData];
      let contextImported = false;
      let resourcesProcessed = 0;

      if (clearCollections) {
        await ontologyCollection.deleteMany({});
        await contextCollection.deleteMany({});
      }

      for (const resource of resources) {
        // Check if this is the special context resource
        if (resource._id === "@context" && resource["@context"]) {
          await this._importContext(resource["@context"], contextCollection);
          contextImported = true;
          continue;
        }

        // Process regular ontology resource
        const processed = await this._processResource(resource, ontologyCollection, contextCollection, opts);
        if (processed) {
          resourcesProcessed++;
        }
      }

      return {
        success: true,
        filePath,
        contextImported,
        resourcesProcessed,
        totalResources: resources.length
      };
    }
    catch (error) {
      throw new Error(`Failed to import ontology from ${filePath}: ${error.message}`);
    }
  }

  /**
   * Import context into Context collection
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
   * Process a single resource for import
   * @private
   */
  async _processResource(resource, ontologyCollection, contextCollection, opts) {
    const { ontologize = true, shareTBox = false } = opts;

    // Convert @id to _id if needed
    if (resource["@id"] && !resource._id) {
      resource._id = resource["@id"];
      delete resource["@id"];
    }

    // TODO: Compact resource with LD.compact when available

    // Check if this is a TBox resource (ontology resource)
    let isTBoxResource = false;
    if (ontologize) {
      isTBoxResource = this._isTBoxResource(resource);

      if (isTBoxResource) {
        // Save to Ontology collection
        await ontologyCollection.replaceOne(
          { _id: resource._id },
          resource,
          { upsert: true }
        );

        // Don't persist to main collection if shareTBox is false
        if (!shareTBox) {
          return true;
        }
      }
    }

    // If not TBox or shareTBox is true, save to main collection (ontologyCollection in this case)
    if (!isTBoxResource || shareTBox) {
      await ontologyCollection.replaceOne(
        { _id: resource._id },
        resource,
        { upsert: true }
      );
    }

    return true;
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
  async _importBOLDContext(contextData, contextCollection) {
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
  async _processBOLDResource(resource, context, ontologyCollection, contextCollection, opts) {
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
