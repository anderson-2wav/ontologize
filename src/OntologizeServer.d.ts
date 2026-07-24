/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { Ontologize, OntologizeOptions, Resource, MongoCollection } from "../index";

export interface ImportOptions {
  /** JSON-LD context to use for compaction */
  context?: Record<string, any>;
  /** default ABox collection */
  collection?: MongoCollection,
  /** Use LD.compact for BOLD resource normalization */
  normalize?: boolean;
  /** Classify resources as TBox/ABox */
  ontologize?: boolean;
  /** Store TBox resources in both collections */
  shareTBox?: boolean;
  /** Store Statement resources in both Statements collection and target collection (default: false) */
  shareStatements?: boolean;
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
  statementResources: number;
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
  isStatement: boolean;
  resource: Resource;
}

export interface ExplorerOptions {
  /** Whether to recurse into embedded resources */
  recurse?: boolean;
}

export interface ExplorerMap {
  /** Informational README about the explorer map */
  README: string;
  /** Mapping of @types to their properties and ontology definitions */
  [typeName: string]: any;
}

/** `ontologizeServer.io` — JSON-LD import/export and bootstrap. */
export declare class IoApi {
  bootstrap(opts?: Record<string, any>): Promise<Record<string, any>>;
  loadJsonFile(filePath: string): Promise<Resource | Resource[]>;
  importFromFile(filePath: string, opts?: ImportOptions): Promise<ImportResult>;
  importData(data: Resource | Resource[], opts?: ImportOptions): Promise<ImportResult>;
  exportToFile(filePath: string, collection: MongoCollection, opts?: ImportOptions): Promise<ImportResult>;
  exportData(collection: MongoCollection, opts?: ImportOptions): Promise<ImportResult>;
  ensurePropertyContext(propertyResource: Resource, contextCollection: MongoCollection): Promise<void>;
}

/** `ontologizeServer.archive` — mongodump / mongorestore. */
export declare class ArchiveApi {
  restoreFromArchive(opts?: { archive?: string; archivePath?: string; mongoUrl?: string }): Promise<{ success: boolean; message: string }>;
  dumpToArchive(opts: { archive: string; archivePath?: string; mongoUrl?: string }): Promise<{ success: boolean; message: string; archivePath: string; bytes: number }>;
}

/** `ontologizeServer.rdf` — RDF/SPARQL serialization and HyLAR fact assembly. */
export declare class RdfApi {
  getTriplesForResources(resources: Resource | Resource[], opts?: Record<string, any>): Promise<Array<{ s: string; p: string; o: string }>>;
  createSparqlInsert(triples: Array<{ s: string; p: string; o: string }>, opts?: Record<string, any>): Promise<string>;
  assembleFactsIntoResources(facts: any[], opts?: Record<string, any>): Promise<Resource[]>;
  createStatementsForFacts(facts: any[], opts?: Record<string, any>): Promise<Resource[]>;
}

/** `ontologizeServer.reasoner` — HyLAR reasoning integration and process management. */
export declare class ReasonerApi {
  bootstrapReasoner(opts?: Record<string, any>): Promise<Record<string, any>>;
  warmReasoner(opts?: Record<string, any>): Promise<Record<string, any>>;
  ensureReasoner(opts?: Record<string, any>): Promise<void>;
  checkHylar(opts?: Record<string, any>): Promise<void>;
  reasonCollection(collectionName: string, opts?: Record<string, any>): Promise<Record<string, any>>;
}

/**
 * Server-only extension of the Ontologize class
 * These methods require Node.js environment and should not be used in browser contexts
 */
export declare class OntologizeServer extends Ontologize {
  /**
   * Create a new OntologizeServer instance
   */
  constructor(ontologyCollection: MongoCollection, contextCollection: MongoCollection, statementsCollection: MongoCollection, opts?: OntologizeOptions);

  /** `io` namespace — JSON-LD import/export and bootstrap. */
  readonly io: IoApi;
  /** `archive` namespace — mongodump / mongorestore. */
  readonly archive: ArchiveApi;
  /** `rdf` namespace — RDF/SPARQL serialization and HyLAR fact assembly. */
  readonly rdf: RdfApi;
  /** `reasoner` namespace — HyLAR reasoning integration and process management. */
  readonly reasoner: ReasonerApi;

  /** Determine if a resource is a TBox (ontology) resource. */
  isTBoxResource(resource: Resource): Promise<boolean>;
  /** Resolve the collection a resource should be stored in. */
  getCollectionForResource(resource: Resource, opts?: Record<string, any>): Promise<any>;
  /** Update a resource, capturing HyLAR inferences as properties and statements. */
  updateOne(resourceId: string, update: Record<string, any>, opts?: Record<string, any>): Promise<Record<string, any>>;
  /** Clear the JSON-property caches (delegates to the shared JsonPropertyStore). */
  clearJsonPropertyCache(): void;

  // ---------------------------------------------------------------------------
  // Deprecated flat API. These forward to their namespace method and will be
  // removed in a later release. Prefer the namespace form shown in @deprecated.
  // ---------------------------------------------------------------------------

  /** @deprecated Use `ontologizeServer.io.bootstrap`. */
  bootstrap(opts?: Record<string, any>): Promise<Record<string, any>>;
  /** @deprecated Use `ontologizeServer.io.loadJsonFile`. */
  loadJsonFile(filePath: string): Promise<Resource | Resource[]>;
  /** @deprecated Use `ontologizeServer.io.importFromFile`. */
  importFromFile(filePath: string, opts?: ImportOptions): Promise<ImportResult>;
  /** @deprecated Use `ontologizeServer.io.importData`. */
  importData(data: Resource | Resource[], opts?: ImportOptions): Promise<ImportResult>;
  /** @deprecated Use `ontologizeServer.io.exportToFile`. */
  exportToFile(filePath: string, collection: MongoCollection, opts?: ImportOptions): Promise<ImportResult>;
  /** @deprecated Use `ontologizeServer.io.exportData`. */
  exportData(collection: MongoCollection, opts?: ImportOptions): Promise<ImportResult>;
  /** @deprecated Use `ontologizeServer.reasoner.reasonCollection` / `.bootstrapReasoner`, etc. */
  reasonCollection(collectionName: string, opts?: Record<string, any>): Promise<Record<string, any>>;
}

export default OntologizeServer;
