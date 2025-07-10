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
  async saveToMongoDB(collection, resources, opts = {}) {
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
  async importOntologyToMongoDB(filePath, collection, opts = {}) {
    check(filePath, String);
    check(collection, Object);
    check(opts, Object);
    
    try {
      const ontologyData = await this.loadOntologyFromFile(filePath);
      const result = await this.saveToMongoDB(collection, ontologyData, opts);
      
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
}

// Export the extended class as default
export default OntologizeServer;