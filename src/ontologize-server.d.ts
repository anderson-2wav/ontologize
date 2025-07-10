/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { Ontologize, OntologizeOptions, Resource } from "../index";

export interface MongoCollection {
  deleteMany(filter: Record<string, any>): Promise<any>;
  replaceOne(filter: Record<string, any>, replacement: any, options?: any): Promise<any>;
  insertOne(document: any): Promise<any>;
  find(filter: Record<string, any>, options?: any): { toArray(): Promise<any[]> };
}

export interface SaveToMongoDBOptions {
  /** Use upsert operation */
  upsert?: boolean;
  /** Clear collection before inserting */
  clearCollection?: boolean;
}

export interface SaveToMongoDBResult {
  success: boolean;
  count: number;
  results: any[];
}

export interface ImportResult extends SaveToMongoDBResult {
  filePath: string;
}

/**
 * Server-only extension of the Ontologize class
 * These methods require Node.js environment and should not be used in browser contexts
 */
export declare class OntologizeServer extends Ontologize {
  /**
   * Create a new OntologizeServer instance
   */
  constructor(opts?: OntologizeOptions);

  /**
   * Load ontology data from a file
   */
  loadOntologyFromFile(filePath: string): Promise<Resource>;

  /**
   * Load multiple ontology files from a directory
   */
  loadOntologiesFromDirectory(dirPath: string, extension?: string): Promise<Resource[]>;

  /**
   * Save resources to MongoDB collection
   */
  saveToCollection(
    collection: MongoCollection,
    resources: Resource | Resource[],
    opts?: SaveToMongoDBOptions
  ): Promise<SaveToMongoDBResult>;

  /**
   * Import ontology data from file and save to MongoDB
   */
  importOntology(
    filePath: string,
    collection: MongoCollection,
    opts?: SaveToMongoDBOptions
  ): Promise<ImportResult>;

  /**
   * Query MongoDB for ontology resources
   */
  queryMongoDB(
    collection: MongoCollection,
    query: Record<string, any>,
    opts?: Record<string, any>
  ): Promise<Resource[]>;
}

export default OntologizeServer;
