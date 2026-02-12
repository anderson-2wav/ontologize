/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
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
  /** Date format string (date-fns format). Default: "M/d/yyyy" */
  dateFormat?: string;
  /** DateTime format string (date-fns format). Default: "M/d/yyyy h:mm a" */
  dateTimeFormat?: string;
  /** Timezone for date formatting. Default: "America/Los_Angeles" */
  dateTimeZone?: string;
}

export interface GetLabelOptions {
  /** Cache Map for ontology lookups to reduce repeated findOne calls */
  ontologyCache?: Map<string, Resource | null>;
}

export interface GetLocationOptions {
  /** Cache Map for ontology lookups to reduce repeated findOne calls */
  ontologyCache?: Map<string, Resource | null>;
}

export interface FormatDateOptions {
  /** Override date format string (date-fns format) */
  dateFormat?: string;
  /** Override datetime format string (date-fns format) */
  dateTimeFormat?: string;
  /** Include time in output (uses dateTimeFormat instead of dateFormat) */
  includeTime?: boolean;
}

export interface SunriseSunsetResponse {
  /** Sunrise time as ISO string */
  sunrise: string;
  /** Sunset time as ISO string */
  sunset: string;
  /** Solar noon time as ISO string */
  solarNoon: string;
  /** Day length in seconds */
  dayLength: number;
  /** Civil twilight begin time as ISO string */
  civilTwilightBegin: string;
  /** Civil twilight end time as ISO string */
  civilTwilightEnd: string;
  /** Nautical twilight begin time as ISO string */
  nauticalTwilightBegin: string;
  /** Nautical twilight end time as ISO string */
  nauticalTwilightEnd: string;
  /** Astronomical twilight begin time as ISO string */
  astronomicalTwilightBegin: string;
  /** Astronomical twilight end time as ISO string */
  astronomicalTwilightEnd: string;
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
  getGeoJSON(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONGeometry | null>;

  /**
   * Get context for compaction from provided context, Context collection, or default
   */
  getContext(providedContext?: Record<string, any> | null): Promise<Record<string, any>>;

  /**
   * Get module version
   */
  getVersion(): string;

  /**
   * Format a date value for display.
   *
   * Accepts Date objects, ISO strings, timestamps (numbers), or JSON-LD @value wrappers.
   * Uses configured timezone (opts.dateTimeZone) for consistent formatting.
   *
   * @param date - The date to format (Date, string, number, or { "@value": string })
   * @param opts - Optional format overrides
   * @returns Formatted date string, or empty string if invalid
   */
  formatDate(date: Date | string | number | { "@value": string; "@type"?: string } | null | undefined, opts?: FormatDateOptions): string;

  /**
   * Format a date value with time for display (shorthand for formatDate with includeTime: true)
   *
   * @param date - The date to format (Date, string, number, or { "@value": string })
   * @param opts - Optional format overrides (same as formatDate)
   * @returns Formatted date-time string, or empty string if invalid
   */
  formatDateTime(date: Date | string | number | { "@value": string; "@type"?: string } | null | undefined, opts?: FormatDateOptions): string;

  /**
   * Get sunrise and sunset times for a location and date.
   *
   * Uses the sunrise-sunset.org API to get solar event times.
   *
   * @param longLat - Array of [longitude, latitude]
   * @param date - The date (accepts same formats as formatDate)
   * @param opts - Options (reserved for future use)
   * @returns Sunrise/sunset info with ISO date strings
   * @throws Error if the API call fails or parameters are invalid
   */
  getSunriseSunset(longLat: [number, number], date: Date | string | number | { "@value": string; "@type"?: string }, opts?: Record<string, any>): Promise<SunriseSunsetResponse>;

  /** Default context with common namespace mappings */
  static DEFAULT_CONTEXT: Record<string, any>;
}

export default Ontologize;

export interface QuerySpec {
  /** Readable name for this query (used in UI) */
  name: string;
  /** Registered name of the Ontologize collection */
  collection: string;
  /** MongoDB query selector */
  selector?: Record<string, any>;
  /** Query options (sort, limit, projection, etc.) */
  opts?: Record<string, any>;
}

/**
 * Query - A standard query specifier for Ontologize collections.
 *
 * Represents a named MongoDB query against a registered Ontologize collection.
 * Instances validate on construction and serialize cleanly to/from JSON.
 */
export declare class Query {
  static readonly TYPE: "ontologize:Query";

  readonly name: string;
  readonly collection: string;
  readonly selector: Record<string, any>;
  readonly opts: Record<string, any>;

  constructor(spec: QuerySpec);

  /** Create a Query from a plain object, or return an existing Query instance as-is. */
  static from(obj: QuerySpec | Query): Query;

  /** Serialize to a plain object with @type discriminator. */
  toJSON(): QuerySpec & { "@type": "ontologize:Query" };
}
