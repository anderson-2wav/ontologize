/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { check, Match } from "./lib/check.js";
import { Ontologize } from "./ontologize.js";

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
   * Import ontology data from JSON-LD file into collections
   * Handles both context import and resource import following CLAUDE.md patterns
   *
   * @param {string} filePath - Path to JSON-LD ontology file
   * @param {object} ontologyCollection - MongoDB Ontology collection instance
   * @param {object} contextCollection - MongoDB Context collection instance
   * @param {object} [opts] - Import options
   * @param {boolean} [opts.ontologize=true] - Determine if resources are TBox resources
   * @param {boolean} [opts.shareTBox=false] - Persist TBox resources to param collection
   * @param {boolean} [opts.clearCollections=false] - Clear collections before importing
   * @returns {Promise<object>} Import result with counts
   */
  async importOntologyFromFile(filePath, ontologyCollection, contextCollection, opts = {}) {
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
}

// Export the extended class as default
export default OntologizeServer;
