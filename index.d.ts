/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

export interface OntologizeOptions {
  /** Named collections in addition to ontology, context, and statements */
  collections?: Record<string, any>;
  /** Default JSON-LD context */
  defaultContext?: Record<string, any>;
  /** Enable debug logging */
  debug?: boolean;
  /** Properties to check for labels (in order of preference) */
  labelProperties?: string[];
  /** Properties to check for descriptions (in order of preference) */
  descriptionProperties?: string[];
}

export interface GetLabelOptions {
  /** Cache Map for ontology lookups to reduce repeated findOne calls */
  ontologyCache?: Map<string, Resource | null>;
}

export interface GetLocationOptions {
  /** Cache Map for ontology lookups to reduce repeated findOne calls */
  ontologyCache?: Map<string, Resource | null>;
}

/**
 * GeoJSON Point geometry
 */
export interface GeoJSONPoint {
  type: "Point";
  coordinates: [number, number];  // [longitude, latitude]
}

/**
 * GeoJSON Geometry (simplified - can be extended)
 */
export type GeoJSONGeometry = GeoJSONPoint | {
  type: string;
  coordinates?: any;
  geometries?: GeoJSONGeometry[];
};

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
    Statements: MongoCollection;
    [key: string]: MongoCollection;
  };
  /** Configuration options */
  opts: OntologizeOptions;
  /** Module version */
  version: string;

  /**
   * Create a new Ontologize instance
   */
  constructor(ontologyCollection: MongoCollection, contextCollection: MongoCollection, statementsCollection: MongoCollection, opts?: OntologizeOptions);

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
   * Get the label for a resource, checking properties in order of preference.
   * Property order can be overridden by bui:schema.labelProperties on the resource's class,
   * otherwise uses opts.labelProperties (default: dcterms:title, foaf:name, rdfs:label)
   */
  getLabel(resource: Resource, property?: string, fallback?: string): Promise<string>;
  getLabel(resource: Resource, property?: string, opts?: GetLabelOptions): Promise<string>;
  getLabel(resource: Resource, property?: string, fallback?: string, opts?: GetLabelOptions): Promise<string>;

  /**
   * Get the geospatial location for a resource as a GeoJSON object.
   *
   * Checks for location data in this order of preference:
   * 1. `geo:lat` and `geo:long` properties - returns a GeoPoint
   * 2. Any property with `rdfs:range` of `bold:GeoPoint`
   * 3. Any property with `rdfs:range` of `bold:GeoJSON`
   *
   * @returns GeoJSON object (typically a Point), or null if no location found
   */
  getLocation(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONGeometry | null>;

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
