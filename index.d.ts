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

/**
 * Application-supplied image resolver. Called by `getImageUrl` when no
 * configured image property carries a usable URL. Return `{ url, generic }`
 * to supply an image; return null or undefined to decline.
 */
export type ImageResolver = (
  resource: Resource,
  opts?: Record<string, any>
) =>
  | Promise<{ url: string; generic: boolean } | null | undefined>
  | { url: string; generic: boolean }
  | null
  | undefined;

export interface OntologizeOptions {
  /** Named collections in addition to ontology, context, and statements */
  collections?: Record<string, any>;
  /** Default JSON-LD context */
  defaultContext?: Record<string, any>;
  /** Enable debug logging */
  debug?: boolean;
  /** Properties to check for labels (in order of preference) */
  labelProperties?: string[];
  /** Properties to check for images (in order of preference). Default: ["bold:img"] */
  imageProperties?: string[];
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
  /** Application-specific image resolver; return null/undefined to decline */
  imageResolver?: ImageResolver;
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
 * Any GeoJSON object `geo.getSpatialDepiction` may return. Deliberately wider
 * than `GeoJSONFeature`: what comes back depends on which property supplied the
 * depiction, and a depiction is legitimately a Feature *or* a FeatureCollection
 * (or a bare Geometry). Callers branch on `type` rather than assume.
 */
export type GeoJSONObject = GeoJSONGeometry | GeoJSONFeature | {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
};

/** Reported on a merged Feature at `properties["bold:mergeDiagnostics"]`. */
export interface MergeDiagnostics {
  /** shapes handed to the union */
  inputs: number;
  /** inputs carrying no areal geometry, skipped rather than rejected */
  skippedNonAreal: number;
  outerRings: number;
  holes: number;
  /** interior rings discarded as slivers — non-zero means the inputs disagreed */
  holesDropped: number;
  /** exterior-ring winding emitted: "ccw" is RFC 7946, "cw" is d3-geo */
  winding: "ccw" | "cw";
  contiguous: boolean;
  areaKm2: number;
  vertices: number;
  /** resources asked for (GeoApi#mergeShapes only) */
  requested?: number;
  /** resources that resolved to nothing (GeoApi#mergeShapes only) */
  unresolved?: number;
}

export interface MergeShapesOptions {
  /** properties for the resulting Feature */
  properties?: Record<string, any>;
  /** m²; interior rings below this are dropped as slivers. 0 keeps every ring. */
  minHoleArea?: number;
  /** picks a depiction for a resource carrying several */
  select?: (depictions: GeoJSONObject[], resource: Resource) => GeoJSONObject | null;
  /**
   * Exterior-ring winding of the result: as the input was wound (default),
   * RFC 7946 (`ccw`), or d3-geo (`cw`). The wrong convention makes d3 draw the
   * complement of the region rather than nothing.
   */
  winding?: "match" | "ccw" | "cw";
  /** attach `bold:mergeDiagnostics` (default true) */
  diagnostics?: boolean;
  ontologyCache?: Map<string, any>;
}

/** Reported on a range Feature at `properties["bold:rangeDiagnostics"]`. */
export interface RangeDiagnostics {
  /** shapes handed to the hull */
  inputs: number;
  /** positions extracted from them, duplicates included */
  positions: number;
  /** what the hull actually saw — duplicates are the norm in tracking data */
  distinctPositions: number;
  hullType: "convex" | "concave";
  /** concavity used, or null for a convex hull */
  alpha: number | null;
  /** exterior-ring winding emitted: "ccw" is RFC 7946, "cw" is d3-geo */
  winding: "ccw" | "cw";
  vertices: number;
  areaKm2: number;
  /** resources asked for (GeoApi#getSpatialRange only) */
  requested?: number;
  /** resources that resolved to nothing (GeoApi#getSpatialRange only) */
  unresolved?: number;
}

export interface GetSpatialRangeOptions {
  /** properties for the resulting Feature */
  properties?: Record<string, any>;
  /** boundary shape; `concave` is an alpha shape (default "convex") */
  hullType?: "convex" | "concave";
  /** concavity 0…1, `concave` only (default 0.5) */
  alpha?: number;
  /**
   * Exterior-ring winding of the result (default `cw`, the d3-geo and
   * `2dsphere` convention). No `"match"`: a hull built from positions has no
   * input winding to match.
   */
  winding?: "ccw" | "cw";
  /** picks a depiction for a resource carrying several */
  select?: (depictions: GeoJSONObject[], resource: Resource) => GeoJSONObject | null;
  /** attach `bold:rangeDiagnostics` (default true) */
  diagnostics?: boolean;
  ontologyCache?: Map<string, any>;
}

export interface UpdateSpatialRangeOptions {
  /** Query (or plain spec) for the resources written onto */
  individuals: QuerySpec | Query;
  /** Query (or plain spec) for the resources hulled */
  geoData: QuerySpec | Query;
  /** property on a geo resource naming its individual (default "bold:animal") */
  groupProperty?: string;
  /** where the Feature is written (default "bold:spatialRange") */
  property?: string;
  hullType?: "convex" | "concave";
  alpha?: number;
  winding?: "ccw" | "cw";
  /** merged into every Feature's properties */
  properties?: Record<string, any>;
  /** $unset the property when no hull can be built (default false) */
  clearEmpty?: boolean;
  /** compute everything, write nothing (default false) */
  dryRun?: boolean;
  ontologyCache?: Map<string, any>;
}

/** One entry per individual that got a hull. */
export interface SpatialRangeSummary {
  id: string;
  areaKm2: number;
  vertices: number;
  positions: number;
  distinctPositions: number;
  /** mean of every position that went in, as [lng, lat] — `properties.centroid` */
  centroid: [number, number];
}

export interface SpatialRangeUpdateResult {
  /** individuals matched by the individuals query */
  individuals: number;
  /** geo docs read */
  geoResources: number;
  /** geo docs that yielded no depiction */
  geoUnresolved: number;
  updated: number;
  cleared: number;
  skipped: number;
  /** distinct group values naming no matched individual */
  unmatched: number;
  durationMs: number;
  ranges: SpatialRangeSummary[];
  /** id → why it got no range; the cleared ones too, under clearEmpty */
  skippedReasons: Record<string, string>;
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
  /** Execute a batch of write operations (e.g. `updateOne` entries), as used by `geo.updateSpatialRange`. */
  bulkWrite(operations: Array<Record<string, any>>, options?: Record<string, any>): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
}

/**
 * Ontologize - Utilities for working with ontology data in JSON-LD format
 *
 * This class provides client/server safe functions for ontology processing.
 */

/** `ontologize.display` — UI presentation helpers (labels, descriptions, dates). */
export declare class DisplayApi {
  setLabelResolver(resolver: LabelResolver | null): void;
  setImageResolver(resolver: ImageResolver | null): void;
  setInfoComponentResolver(resolver: ((resource: Resource, hint?: any) => any) | null): void;
  getInfoComponent(resource: Resource, hint?: any): any;
  getLabel(resource: Resource, property?: string, fallback?: string): Promise<string>;
  getLabel(resource: Resource, property?: string, opts?: GetLabelOptions): Promise<string>;
  getLabel(resource: Resource, property?: string, fallback?: string, opts?: GetLabelOptions): Promise<string>;
  getLabelProperty(resource: Resource, fallback?: string): Promise<string>;
  /**
   * `property` is the matched `imageProperties` key when the image came from
   * the resource itself, or `null` when it was supplied by the image
   * resolver (the resolver does not report a property).
   */
  getImageUrl(resource: Resource, opts?: Record<string, any>): Promise<{ url: string; generic: boolean; property: string | null } | null>;
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
   * The resource's spatial depiction as a GeoJSON object — not specifically a
   * Feature. `geo:lat`/`geo:long` synthesise a bare Point geometry, while a
   * `bold:GeoJSON`-ranged property (e.g. `bold:spatialDepiction`) yields
   * whatever it holds — commonly a Feature, but equally a Geometry,
   * FeatureCollection, or GeometryCollection. Branch on `type`.
   */
  getSpatialDepiction(resource: Resource, opts?: GetLocationOptions): Promise<GeoJSONObject | null>;
  /**
   * Union several resources' depictions into one Feature. Diagnostics land on
   * `properties["bold:mergeDiagnostics"]`; assert `holesDropped === 0 &&
   * contiguous` when building a region.
   */
  mergeShapes(
    resources: Array<string | Resource> | string | Resource,
    opts?: MergeShapesOptions
  ): Promise<GeoJSONFeature | null>;
  /**
   * The hull enclosing several resources' spatial data — a home range from
   * tracking reports. Reads positions, not areas, so points, lines and polygons
   * mix freely. Diagnostics land on `properties["bold:rangeDiagnostics"]`.
   */
  getSpatialRange(
    resources: Array<string | Resource> | string | Resource,
    opts?: GetSpatialRangeOptions
  ): Promise<GeoJSONFeature | null>;
  /**
   * Compute a spatial range for each of a set of individuals and store it.
   * Buckets the geo query by `groupProperty` and writes one Feature per
   * individual. Server-side in practice: it needs a write-capable collection.
   */
  updateSpatialRange(opts: UpdateSpatialRangeOptions): Promise<SpatialRangeUpdateResult>;
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
  /** Result count, when the query carries one (e.g. from ExploreApi) */
  count?: number;
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
