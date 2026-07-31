/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Application-supplied label resolver. Called by `getLabel` when no standard
 * label property is found. Return a non-null string to provide the label;
 * return null or undefined to decline and let the built-in fallback run.
 */
export type LabelResolver = (
  resource: Resource,
  opts?: GetLabelOptions
) => Promise<string | null | undefined> | string | null | undefined;

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
  /** Application-specific label resolver; return null/undefined to decline */
  labelResolver?: LabelResolver;
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

/**
 * GeoJSON Feature — a geometry plus arbitrary properties.
 */
export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry;
  properties?: Record<string, any> | null;
}

/**
 * Any GeoJSON object `geo.getSpatialDepiction` may return. It is deliberately
 * wider than `GeoJSONFeature`: what comes back depends on which property
 * supplied the depiction, so callers must branch on `type` rather than assume.
 */
export type GeoJSONObject = GeoJSONGeometry | GeoJSONFeature | {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
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

/** `ontologize.display` — UI presentation helpers (labels, descriptions, dates). */
export declare class DisplayApi {
  setLabelResolver(resolver: LabelResolver | null): void;
  setInfoComponentResolver(resolver: ((resource: Resource, hint?: any) => any) | null): void;
  getInfoComponent(resource: Resource, hint?: any): any;
  getLabel(resource: Resource, property?: string, fallback?: string): Promise<string>;
  getLabel(resource: Resource, property?: string, opts?: GetLabelOptions): Promise<string>;
  getLabel(resource: Resource, property?: string, fallback?: string, opts?: GetLabelOptions): Promise<string>;
  getLabelProperty(resource: Resource, fallback?: string): Promise<string>;
  getLabelFromId(resourceId: string, fallback?: string): Promise<string>;
  getDescription(resource: Resource, fallback?: string): Promise<string>;
  getDescriptionProperty(resource: Resource, fallback?: string): Promise<string>;
  formatDate(date: Date | string | number | { "@value": string; "@type"?: string } | null | undefined, opts?: FormatDateOptions): string;
  formatDateTime(date: Date | string | number | { "@value": string; "@type"?: string } | null | undefined, opts?: FormatDateOptions): string;
  assignIndividualColors(ids: string[], scheme?: string[]): Map<string, string>;
  fetchIndividualLabels(ids: string[]): Promise<Map<string, string>>;
  groupResources(resources: Resource[], group: { label: string; property: string }, opts?: { includeUngrouped?: boolean }): Map<string | null, Resource[]>;
  buildGroupOptions(resources: Resource[], group: { label: string; property: string }, colorScheme?: string[]): Promise<Array<{ _id: string | null; label: string; color: string; count: number }>>;
}

/** `ontologize.schema` — TBox schema introspection. */
export declare class SchemaApi {
  getSchema(property?: string, resource?: Resource, opts?: { ontologyCache?: Map<string, any> }): Promise<Record<string, any>>;
  isArrayProperty(property: string | Resource, opts?: { context?: Record<string, any>; cached?: boolean }): Promise<boolean>;
  sortTypesFn(types: string[], opts?: { cached?: boolean }): Promise<string[]>;
  getGroupStrategies(resource: Resource, opts?: { ontologyCache?: Map<string, any> }): Promise<Array<{ label: string; property: string }>>;
}

/** `ontologize.geo` — instance-bound geospatial helpers. */
export declare class GeoApi {
  /**
   * The resource's spatial depiction as GeoJSON. Not necessarily a Feature:
   * `geo:lat`/`geo:long` synthesise a bare Point geometry, while a
   * `bold:GeoJSON`-ranged property (e.g. `bold:spatialDepiction`) yields
   * whatever it holds — commonly a Feature, but possibly a Geometry,
   * FeatureCollection, or GeometryCollection.
   */
  getSpatialDepiction(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONObject | null>;
  /** @deprecated Use `getSpatialDepiction`. */
  getGeoJSON(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONObject | null>;
  getSunriseSunset(longLat: [number, number], date: Date | string | number | { "@value": string; "@type"?: string }, opts?: Record<string, any>): Promise<SunriseSunsetResponse>;
}

/**
 * `ontologize.explore` — scan the ontology structure and ABox collections.
 * Returns **raw** resources (serialization-safe), not LD proxies.
 */
export declare class ExploreApi {
  run(collections?: Array<object> | Array<string>, opts?: { recurse?: boolean; classFilter?: string[] }): Promise<Record<string, any>>;
}

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

  /** `display` namespace — labels, descriptions, date formatting, colors/grouping. */
  readonly display: DisplayApi;
  /** `schema` namespace — TBox schema introspection. */
  readonly schema: SchemaApi;
  /** `geo` namespace — instance-bound geospatial helpers. */
  readonly geo: GeoApi;
  /** `explore` namespace — scan ontology structure and ABox collections (raw resources). */
  readonly explore: ExploreApi;

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
   * Get context for compaction from provided context, Context collection, or default
   */
  getContext(providedContext?: Record<string, any> | null): Promise<Record<string, any>>;

  /**
   * Get module version
   */
  getVersion(): string;

  // ---------------------------------------------------------------------------
  // Deprecated flat API. These forward to their namespace method and will be
  // removed in a later release. Prefer the namespace form shown in @deprecated.
  // ---------------------------------------------------------------------------

  /** @deprecated Use `ontologize.display.setLabelResolver`. */
  setLabelResolver(resolver: LabelResolver | null): void;
  /** @deprecated Use `ontologize.display.getLabel`. */
  getLabel(resource: Resource, property?: string, fallback?: string): Promise<string>;
  getLabel(resource: Resource, property?: string, opts?: GetLabelOptions): Promise<string>;
  getLabel(resource: Resource, property?: string, fallback?: string, opts?: GetLabelOptions): Promise<string>;
  /** @deprecated Use `ontologize.geo.getSpatialDepiction`. */
  getSpatialDepiction(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONObject | null>;
  /** @deprecated Use `ontologize.geo.getSpatialDepiction`. */
  getGeoJSON(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONObject | null>;
  /** @deprecated Use `ontologize.display.formatDate`. */
  formatDate(date: Date | string | number | { "@value": string; "@type"?: string } | null | undefined, opts?: FormatDateOptions): string;
  /** @deprecated Use `ontologize.display.formatDateTime`. */
  formatDateTime(date: Date | string | number | { "@value": string; "@type"?: string } | null | undefined, opts?: FormatDateOptions): string;
  /** @deprecated Use `ontologize.geo.getSunriseSunset`. */
  getSunriseSunset(longLat: [number, number], date: Date | string | number | { "@value": string; "@type"?: string }, opts?: Record<string, any>): Promise<SunriseSunsetResponse>;
  /** @deprecated Use `ontologize.explore.run`. */
  explorer(collections?: Array<object> | Array<string>, opts?: { recurse?: boolean; classFilter?: string[] }): Promise<Record<string, any>>;

  /** Default context with common namespace mappings */
  static DEFAULT_CONTEXT: Record<string, any>;
  /** Default color scheme for individuals (re-exported from DisplayApi). */
  static DEFAULT_COLOR_SCHEME: string[];
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
