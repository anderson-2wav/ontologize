/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

export interface OntologizeOptions {
  /** Default JSON-LD context */
  context?: Record<string, any>;
  /** Enable debug logging */
  debug?: boolean;
}

export type Resource = Record<string, any>;
export type OntologyResource = Resource & {
  "@id": string;
  "@type": string | string[];
};

/**
 * Ontologize - Utilities for working with ontology data in JSON-LD format
 * 
 * This class provides client/server safe functions for ontology processing.
 */
export declare class Ontologize {
  /** Configuration options */
  opts: OntologizeOptions;
  /** Module version */
  version: string;

  /**
   * Create a new Ontologize instance
   */
  constructor(opts?: OntologizeOptions);

  /**
   * Validate that a resource is a valid ontology resource
   */
  isValidOntologyResource(resource: Resource): resource is OntologyResource;

  /**
   * Extract classes from an ontology resource
   */
  extractClasses(resource: Resource): OntologyResource[];

  /**
   * Extract properties from an ontology resource
   */
  extractProperties(resource: Resource): OntologyResource[];

  /**
   * Get the label for a resource, preferring rdfs:label
   */
  getLabel(resource: Resource, fallback?: string): string;

  /**
   * Get module version
   */
  getVersion(): string;
}

export default Ontologize;