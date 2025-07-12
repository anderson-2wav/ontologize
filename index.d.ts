/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import type { Collection } from "mongodb";

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

/**
 * MongoDB Collection type for raw collections obtained via collection.rawCollection()
 * Use Collection<Resource> for typed collections or Collection<any> for flexibility
 */
export type MongoCollection = Collection<any>;

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
