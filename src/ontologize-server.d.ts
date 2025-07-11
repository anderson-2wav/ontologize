/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { Ontologize, OntologizeOptions, Resource, MongoCollection } from "../index";

export interface ImportOptions {
  /** JSON-LD context to use for compaction */
  context?: Record<string, any>;
  /** Use LD.compact for BOLD resource normalization */
  normalize?: boolean;
  /** Classify resources as TBox/ABox */
  ontologize?: boolean;
  /** Store TBox resources in both collections */
  shareTBox?: boolean;
  /** Clear collections before importing */
  clearCollections?: boolean;
  /** Ensure array props including @type */
  ensureArrayProps?: boolean;
  /** Merge TBox resources with existing resources using schema merge strategy */
  mergeOntology?: boolean;
}

export interface ImportResult {
  success: boolean;
  inputSource: "file" | "object";
  filePath: string | null;
  contextImported: boolean;
  totalResources: number;
  processedResources: number;
  tboxResources: number;
  aboxResources: number;
  errors: Array<{
    resource: string;
    error: string;
  }>;
}

export interface ContextAndResources {
  extractedContext: Record<string, any> | null;
  resources: Resource[];
}

export interface ProcessedResource {
  success: boolean;
  isTBox: boolean;
  resource: Resource;
}

/**
 * Server-only extension of the Ontologize class
 * These methods require Node.js environment and should not be used in browser contexts
 */
export declare class OntologizeServer extends Ontologize {
  /**
   * Create a new OntologizeServer instance
   */
  constructor(ontologyCollection: MongoCollection, contextCollection: MongoCollection, opts?: OntologizeOptions);

  /**
   * Load ontology data from a file
   */
  loadOntologyFromFile(filePath: string): Promise<Resource | Resource[]>;

  /**
   * Import ontology from file path with BOLD resource normalization
   * Loads JSON-LD file and imports with proper normalization using LD.compact
   */
  importOntologyFromFile(
    filePath: string,
    collection: MongoCollection,
    opts?: ImportOptions
  ): Promise<ImportResult>;

  /**
   * Import ontology from parsed JSON-LD data with BOLD resource normalization
   * Handles multiple JSON-LD formats and uses LD.compact for proper normalization
   */
  importOntologyData(
    data: Resource | Resource[],
    collection: MongoCollection,
    opts?: ImportOptions
  ): Promise<ImportResult>;

  /**
   * Determine if a resource is a TBox (ontology) resource
   * @private
   */
  private _isTBoxResource(resource: Resource): boolean;

  /**
   * Extract context and resources from JSON-LD input
   * Handles both @graph format and array format
   * Merges all contexts found in array items like CTB Ontology.importContext
   * @private
   */
  private _extractContextAndResources(jsonldData: Resource | Resource[]): ContextAndResources;

  /**
   * Import context into Context collection with sophisticated merge strategy
   * Merges new context data with existing context using specialized conflict resolution
   * In BOLD, the context document contains the context data directly (no nested @context)
   * @private
   */
  private _importContext(contextData: Record<string, any>, contextCollection: MongoCollection): Promise<void>;

  /**
   * Get context for compaction from provided context, Context collection, or default
   * @private
   */
  private _getContextForCompaction(providedContext: Record<string, any> | null, contextCollection: MongoCollection): Promise<Record<string, any>>;

  /**
   * Process a single resource with BOLD normalization using LD.compact
   * @private
   */
  private _normalizeAndSaveResource(
    resource: Resource,
    context: Record<string, any> | null,
    collection: MongoCollection,
    contextCollection: MongoCollection,
    opts: ImportOptions
  ): Promise<ProcessedResource>;

  /**
   * Customizer function for merging context objects with specialized conflict resolution
   * Handles namespace conflicts intelligently based on BOLD/CTB patterns
   * @private
   */
  private _contextAssignCustomizer(objValue: any, srcValue: any, key: string): any;

  /**
   * Schema merge customizer for handling array merging in contexts
   * Ensures arrays are properly merged using union to avoid duplicates
   * @private
   */
  private _schemaMergeCustomizer(objValue: any, srcValue: any, key: string, object: any, source: any, stack: any): any;

  /**
   * Save a resource to a collection with intelligent merge strategy
   * Similar to CTB Ontology.updateOntology, merges with existing resources to preserve data
   * @private
   */
  private _saveResourceWithMerge(resource: Resource, collection: MongoCollection, opts?: { mergeOntology?: boolean }): Promise<void>;

  /**
   * Sort context keys for consistent ordering
   * Places @-prefixed keys first, then namespaces (no colon), then prefixed terms
   * @private
   */
  private _sortContextKeys(context: Record<string, any>): Record<string, any>;
}

export default OntologizeServer;
