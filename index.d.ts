/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

export interface OntologizeOptions {
  /** Named collections in addition to ontology and context */
  collections?: Record<string, any>;
  /** Default JSON-LD context */
  defaultContext?: Record<string, any>;
  /** Enable debug logging */
  debug?: boolean;
}

export type Resource = Record<string, any>;
export type OntologyResource = Resource & {
  "@id": string;
  "@type": string | string[];
};

export interface MongoCollection {
  deleteMany(filter: Record<string, any>): Promise<{ deletedCount: number }>;
  replaceOne(filter: Record<string, any>, replacement: any, options?: any): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedId: any }>;
  insertOne(document: any): Promise<any>;
  find(filter: Record<string, any>, options?: any): { toArray(): Promise<any[]> };
  findOne(filter: Record<string, any>): Promise<any | null>;
}

/**
 * Ontologize - Utilities for working with ontology data in JSON-LD format
 *
 * This class provides client/server safe functions for ontology processing.
 */
export declare class Ontologize {
  /** MongoDB collections */
  collections: {
    Ontology: MongoCollection;
    Context: MongoCollection;
    [key: string]: MongoCollection;
  };
  /** Configuration options */
  opts: OntologizeOptions;
  /** Module version */
  version: string;

  /**
   * Create a new Ontologize instance
   */
  constructor(ontologyCollection: MongoCollection, contextCollection: MongoCollection, opts?: OntologizeOptions);

  /**
   * Validate that a resource is a valid ontology resource
   */
  isValidOntologyResource(resource: Resource): resource is OntologyResource;

  /**
   * Determine if a resource is an RDF Statement resource
   *
   * Detection criteria:
   * - Resource has @type of rdf:Statement
   * - Resource has properties rdf:subject, rdf:predicate, rdf:object (implies Statement by domain)
   */
  isStatementResource(resource: Resource): boolean;

  /**
   * Get the label for a resource, preferring rdfs:label
   */
  getLabel(resource: Resource, fallback?: string): string;

  /**
   * Get context for compaction from provided context, Context collection, or default
   */
  getContext(providedContext?: Record<string, any> | null): Promise<Record<string, any>>;

  /**
   * Get module version
   */
  getVersion(): string;

  /** Default context with common namespace mappings */
  static DEFAULT_CONTEXT: Record<string, any>;
}

export default Ontologize;
