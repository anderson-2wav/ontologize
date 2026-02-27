/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
 */

import { readFile, writeFile } from "fs/promises";
import { check, Match } from "./lib/check.js";
import { Ontologize } from "./Ontologize.js";
import { LD } from "bold-ld";
import _ from "lodash";
import jsonPath from "./lib/jsonpath.js";
import { spawn } from "child_process";
import path from "path";
import * as fs from "node:fs";

/**
 * Server-only extension of the Ontologize class
 * These methods require Node.js environment and should not be used in browser contexts
 */
export class OntologizeServer extends Ontologize {
  // Singleton instance (separate from parent Ontologize._instance)
  static _instance = null;

  /**
   * Initialize the singleton OntologizeServer instance.
   * Must be called before using get().
   *
   * @param {object} ontologyCollection - Collection adapter or raw MongoDB collection
   * @param {object} contextCollection - Collection adapter or raw MongoDB collection
   * @param {object} statementsCollection - Collection adapter or raw MongoDB collection for Statements
   * @param {object} [opts] - Configuration options (same as constructor)
   * @returns {OntologizeServer} The initialized singleton instance
   */
  static initialize(ontologyCollection, contextCollection, statementsCollection, opts = {}) {
    console.log("OntologizeServer.initialize with opts", opts);

    OntologizeServer._instance = new OntologizeServer(ontologyCollection, contextCollection, statementsCollection, opts);
    return OntologizeServer._instance;
  }

  /**
   * Get the singleton OntologizeServer instance.
   * Throws an error if initialize() has not been called.
   *
   * @returns {OntologizeServer} The singleton instance
   * @throws {Error} If initialize() has not been called
   */
  static get() {
    if (!OntologizeServer._instance) {
      throw new Error("OntologizeServer has not been initialized. Call OntologizeServer.initialize() first.");
    }
    return OntologizeServer._instance;
  }

  /**
   * Create a new OntologizeServer instance
   *
   * @param {object} ontologyCollection
   * @param {object} contextCollection
   * @param {object} statementsCollection
   * @param {object} [opts] - Configuration options (same as Ontologize)
   * @param {string[]} [opts.bootstrapFiles] - Array of file paths for bootstrap ontologies
   * @param {string} [opts.bootstrapPath] - Base path for relative bootstrap file paths
   * @param {object} [opts.collections] - (from Ontologize) named collections in addition to ontology, context, and statements
   * @param {object} [opts.context] - (from Ontologize) Default JSON-LD context
   * @param {boolean} [opts.debug=false] - (from Ontologize) Enable debug logging
   * @param {string[]} [opts.labelProperties] - (from Ontologize) Properties to check for labels (in order of preference)
   * @param {string[]} [opts.descriptionProperties] - (from Ontologize) Properties to check for descriptions (in order of preference)
   * @param {string} [opts.dateFormat="M/d/yyyy"] - (from Ontologize) Default format for dates
   * @param {string} [opts.dateTimeFormat="M/d/yyyy h:mm a"] - (from Ontologize) Default format for date-times
   * @param {string} [opts.dateTimeZone="America/Los_Angeles"] - (from Ontologize) Default timezone for date formatting
   */
  constructor(ontologyCollection, contextCollection, statementsCollection, opts = {}) {
    super(ontologyCollection, contextCollection, statementsCollection, opts);
    this.bootstrapFiles = opts.bootstrapFiles || [];
    this.bootstrapPath = opts.bootstrapPath || path.join((process.env.APP_DIR || process.cwd()),"private/data/bootstrap");
    this.opts = opts;

    // HyLAR process management defaults
    this.hylarUrl = opts.hylarUrl || "http://localhost:4000";
    this.hylarPort = opts.hylarPort || 4000;
    this.hylarProcess = null;
    this._hylarVerified = false;
  }

  /**
   * Bootstrap data from configured files.
   * Imports all files specified in opts.bootstrapFiles
   *
   * @param {object} [opts] - Bootstrap options
   * @param {string[]} [opts.bootstrapFiles] - Override bootstrapFiles from constructor
   * @param {string} [opts.basePath] - Override bootstrapPath from constructor
   * @param {boolean} [opts.removeAll=true] - Clear all collections before first import
   * @returns {Promise<object>} Summary of import results
   */
  async bootstrap(opts = {}) {
    const files = opts.bootstrapFiles || this.bootstrapFiles;
    const basePath = opts.basePath || this.bootstrapPath;
    const removeAll = opts.removeAll !== false;

    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("No bootstrap files configured. Pass opts.bootstrapFiles to constructor or opts.files to bootstrap()");
    }

    if (removeAll) {
      console.log("======== BOOTSTRAP REMOVE ALL ========");
      // from all known collections
      for await (const colName of Object.keys(this.collections)) {
        const collection = this.collections[colName];
        if (collection) {
          const result = await collection.deleteMany({});
          console.log(`removed from ${colName} collection`,result);
        }
      }
    }
    console.log("======== BOOTSTRAP START ========");
    const results = [];

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];

      // Resolve path: absolute paths used as-is, relative paths relative to basePath
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(basePath, filePath);

      try {
        console.log(`Loading ontology data from ${resolvedPath}...`);
        const result = await this.importFromFile(resolvedPath, /* this.collections.ontology, */ {
          normalize: true,
          ontologize: true,
          shareTBox: false
        });

        const summary = {
          file: filePath,
          totalResources: result.totalResources,
          processedResources: result.processedResources,
          tboxResources: result.tboxResources,
          aboxResources: result.aboxResources,
          contextImported: result.contextImported,
          errors: result.errors.length
        };

        console.log(`Import results for ${filePath}:`, summary);

        if (result.errors.length > 0) {
          console.warn(`Import errors for ${filePath}:`, result.errors);
          summary.errorDetails = result.errors;
        }

        results.push(summary);
      }
      catch (fileError) {
        // First file is required, subsequent files are optional
        if (i === 0) {
          throw new Error(`Failed to load required file ${filePath}: ${fileError.message}`);
        }
        console.warn(`Failed to load ${resolvedPath}:`, fileError.message);
        console.warn("Continuing with remaining files...");
        results.push({
          file: filePath,
          error: fileError.message,
          skipped: true
        });
      }
    }

    console.log("======== BOOTSTRAP COMPLETE ========");

    return {
      filesProcessed: results.length,
      results
    };
  }

  /**
   * Load JSON-LD data from a file
   *
   * @param {string} filePath - Path to the ontology file
   * @returns {Promise<object>} Parsed ontology data
   */
  async loadJsonFile(filePath) {
    check(filePath, String);

    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content);
    }
    catch (error) {
      throw new Error(`Failed to load ontology from ${filePath}: ${error.message}`);
    }
  }

  /**
   * Import data from file path with BOLD resource normalization
   * Loads JSON-LD file and imports with proper normalization using LD.compact
   *
   * @param {string} filePath - Path to JSON-LD ontology file
   * @param {object} [opts] - Import options {@see importData}
   *
   * @returns {Promise<object>} Import result with detailed statistics
   */
  async importFromFile(filePath, opts = {}) {
    check(filePath, String);
    check(opts, Object);

    try {
      // Load JSON-LD file
      const jsonldData = await this.loadJsonFile(filePath);

      // Import the loaded data
      const result = await this.importData(jsonldData, opts);

      // Add file path information to result
      return {
        ...result,
        inputSource: "file",
        filePath
      };
    }
    catch (error) {
      throw new Error(`Failed to import ontology from file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Import parsed JSON-LD data with BOLD resource normalization into appropriate collections,
   * including context, TBox and ABox data as per namespace collections.
   *
   * Handles multiple JSON-LD formats and uses LD.compact for proper normalization
   *
   * @param {object|Array} data - Parsed JSON-LD object or array of resources
   * @param {object} [opts] - Import options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {object} [opts.collection] - optional default ABox collection (used if namespace and typed collections aren't found)
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ontologize=true] - Classify resources as TBox/ABox
   * @param {boolean} [opts.shareTBox=false] - Store TBox resources in both collections
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.mergeResources=true] - Merge resources with existing resources using schema merge strategy
   * @param {Function} [opts.beforeSaveFn=null] - Callback to filter/modify resources before saving. Called with normalized resource. May be sync or async.
   Return modified resource to save, or falsey (false/null/undefined) to skip.
   * @param {boolean} [opts.useNamespaceCollections=true] - use named collections by uri prefix (instead of collection param)
   * @param {object} [opts.typeCollections] - { type: collection } indication of special collection for types
   * @param {boolean} [opts.addIsPartOf=true] - Add dcterms:isPartOf to resources indicating which owl:Ontology resources they derive from.
   *   Only ontologies at the beginning of the import are included; stops collecting when first non-ontology is encountered.
   *
   * @returns {Promise<object>} Import result with detailed statistics including skippedResources count
   */
  async importData(data, opts = {}) {
    check(data, Match.OneOf(Object, Array));
    // check(collection, Match.Optional(Object));
    check(opts, Match.Optional(Object));

    const {
      context = null,
      collection = null,
      normalize = true,
      ontologize = true,
      shareTBox = false,
      shareStatements = false,
      ensureArrayProps = true,
      mergeResources = true,
      beforeSaveFn = null,
      typeCollections = null,
      addIsPartOf = true
    } = opts;

    try {
      // Step 1: Extract context and resources
      const { extractedContext: incomingContext, resources } = this._extractContextAndResources(data);

      // Step 2: Clear collections if requested
      // OBSOLETE

      // Step 3: Import context
      let contextImported = false;
      let contextToUse = context || incomingContext;

      if (contextToUse) {
        // ignore @vocab on imported context.
        // It can easily conflict with the application's @vocab,
        // and it will be washed out when imported resources are expanded
        const _incomingContext = _.cloneDeep(contextToUse);
        delete _incomingContext["@vocab"];
        await this._importContext(_incomingContext, this.collections.context);
        contextImported = true;
      }

      // Step 4: Detect leading owl:Ontology resources for dcterms:isPartOf
      // If addIsPartOf is enabled, collect ontology IDs from resources at the beginning
      // Stop collecting when a non-ontology resource is encountered
      let leadingOntologyIds = [];
      if (addIsPartOf) {
        for (const resource of resources) {
          if (this._isOntologyResource(resource)) {
            const id = resource._id || resource["@id"];
            if (id) {
              leadingOntologyIds.push(id);
            }
          }
          else {
            // Stop collecting once we hit a non-ontology resource
            break;
          }
        }
      }

      // Step 5: Process and normalize resources
      const stats = {
        totalResources: resources.length,
        processedResources: 0,
        skippedResources: 0,
        tboxResources: 0,
        aboxResources: 0,
        statementResources: 0,
        errors: []
      };

      for await (const resource of resources) {
        // thinking through current problem.
        // Incoming resources may have properties in a @vocab that conflicts with ours.
        // this would be fixed if we first expand resources with their own context,
        // then compact with ours.
        // console.log(resource._id || resource["@id"]);
        // if ((resource._id || resource["@id"]) === "bold:TrackingReport") {
        // }
        try {
          const processed = await this._normalizeAndSaveResource(
            resource,
            contextToUse,
            collection,
            this.collections.context,
            { normalize, ontologize, shareTBox, shareStatements, ensureArrayProps, mergeResources, beforeSaveFn, typeCollections, addIsPartOf, leadingOntologyIds }
          );

          if (processed) {
            if (processed.skipped) {
              stats.skippedResources++;
            }
            else {
              stats.processedResources++;
              if (processed.isStatement) {
                stats.statementResources++;
              }
              else if (processed.isTBox) {
                stats.tboxResources++;
              }
              else {
                stats.aboxResources++;
              }
            }
          }
        }
        catch (error) {
          stats.errors.push({
            resource: resource._id || resource["@id"] || "unknown",
            error: error.message
          });
        }
      }

      return {
        success: true,
        inputSource: "object",
        filePath: null,
        contextImported,
        ...stats
      };
    }
    catch (error) {
      throw new Error(`Failed to import ontology data: ${error.message}`);
    }
  }

  /**
   * Export collection to file path with BOLD resource normalization
   * to JSON-LD file.
   *
   * @param {string} filePath - Path to JSON-LD file
   * @param {object} collection - MongoDB collection to export from
   * @param {object} [opts] - Export options
   * @param {object} [opts.context] - JSON-LD context to use for compaction (else use default context)
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.expandUris=false] - Convert @id back to full URIs for JSON-LD
   * @returns {Promise<object>} Export result with detailed statistics
   */
  async exportToFile(filePath, collection, opts = {}) {
    check(filePath, String);
    check(collection, Object);
    check(opts, Object);

    const {
      context = null,
      normalize = true,
      ensureArrayProps = true,
      expandUris = false
    } = opts;

    try {
      // Export data from collection
      const result = await this.exportData(collection, {
        context,
        normalize,
        ensureArrayProps,
        expandUris
      });

      // Write to file
      const jsonldContent = JSON.stringify(result.data, null, 2);
      await writeFile(filePath, jsonldContent, "utf-8");

      return {
        ...result,
        outputTarget: "file",
        filePath,
        success: true
      };
    }
    catch (error) {
      throw new Error(`Failed to export to file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Export collection data with BOLD resource normalization
   *
   * @param {object} collection - MongoDB collection to export from
   * @param {object} [opts] - Export options
   * @param {object} [opts.context] - JSON-LD context to use for compaction
   * @param {boolean} [opts.normalize=true] - Use LD.compact for BOLD resource normalization
   * @param {boolean} [opts.ensureArrayProps=true] - Ensure array props including @type
   * @param {boolean} [opts.expandUris=false] - Convert @id back to full URIs for JSON-LD
   * @returns {Promise<object>} Export result with data and statistics
   */
  async exportData(collection, opts = {}) {
    check(collection, Object);
    check(opts, Object);

    const {
      context = null,
      normalize = true,
      ensureArrayProps = true,
      expandUris = false
    } = opts;

    try {
      // Get all documents from collection
      const cursor = collection.find({});
      const documents = await cursor.toArray();

      // Process each document for export
      const processedResources = [];
      const stats = {
        totalResources: documents.length,
        processedResources: 0,
        errors: []
      };

      for (const doc of documents) {
        try {
          let processed = await this._prepareResourceForExport(
            doc,
            context,
            { normalize, ensureArrayProps, expandUris }
          );

          if (processed) {
            processedResources.push(processed);
            stats.processedResources++;
          }
        }
        catch (error) {
          stats.errors.push({
            resource: doc._id || doc["@id"] || "unknown",
            error: error.message
          });
        }
      }

      // Get context for output (remove _id alias — it's a MongoDB convenience, not valid JSON-LD)
      const contextForOutput = { ...(await this.getContext(context)) };
      delete contextForOutput._id;

      // Create JSON-LD output structure with @context
      let data;
      if (processedResources.length === 1) {
        // Single resource with context
        data = {
          "@context": contextForOutput,
          ...processedResources[0]
        };
      }
      else {
        // Multiple resources in @graph format with context
        data = {
          "@context": contextForOutput,
          "@graph": processedResources
        };
      }

      return {
        success: true,
        outputTarget: "object",
        data,
        ...stats
      };
    }
    catch (error) {
      throw new Error(`Failed to export data: ${error.message}`);
    }
  }

  /**
   * Prepare a resource for export with BOLD normalization
   * @private
   */
  async _prepareResourceForExport(resource, context, opts = {}) {
    const {
      normalize = true,
      ensureArrayProps = true,
      expandUris = false
    } = opts;

    let processed = { ...resource };

    // Step 1: Convert _id back to @id for JSON-LD
    // and ensure it is first property
    if (processed._id && !processed["@id"]) {
      const _id = processed._id;
      delete processed._id;
      processed = {
        "@id": _id,
        ...processed
      };
    }

    // Step 2: Ensure @type is array if needed
    if (ensureArrayProps && processed["@type"] && !Array.isArray(processed["@type"])) {
      processed["@type"] = [processed["@type"]];
    }

    // Step 3: Stringify bold:JSON/bui:Schema property values before JSON-LD processing
    // For export, POJOs in MongoDB should become JSON strings in the output file
    processed = await this._stringifyJsonProperties(processed);

    // Step 4: Apply normalization if requested
    if (normalize) {
      try {
        const contextForCompaction = await this.getContext(context);
        const ld = this.ld();

        // Use expand first if we want full URIs, then compact
        if (expandUris) {
          const expanded = await ld.expand(processed, contextForCompaction);
          processed = expanded[0] || processed;
        }
        else {
          // Regular compaction for BOLD format
          const compacted = await ld.compact(processed, contextForCompaction, {
            ensureArrayProps: ensureArrayProps,
            ensureSafeKeys: false, // We want JSON-LD output, not MongoDB-safe keys
            showContext: false,
            proxy: false
          });

          // Handle the case where compact returns an array or @graph
          if (Array.isArray(compacted)) {
            processed = compacted[0] || processed;
          }
          else if (compacted["@graph"]) {
            processed = compacted["@graph"][0] || processed;
          }
          else {
            processed = compacted;
          }
          // final patchup... compact probably turned @id back into _id
          if (processed._id) {
            const _id = processed._id;
            delete processed._id;
            processed = {
              "@id": _id,
              ...processed
            };
          }
        }
      }
      catch (error) {
        console.warn(`Failed to process resource ${resource._id || resource["@id"]} for export: ${error.message}`);
      }
    }

    // Note: We do NOT parse JSON properties back to POJOs for export
    // The stringified values should remain as strings in the output file

    return processed;
  }

  /**
   * Determine if a resource is a TBox (ontology) resource
   */
  async isTBoxResource(resource) {
    // due to JSON-LD idiosyncrasy we can't give @type a @type, so it needs a special case:
    if (resource._id === "@type" || resource._id === "_id") {
      return true;
    }

    if (!resource["@type"]) {
      // if resource doesn't have a type, it might be a partial resource (an update to merge)
      // check if it exists in the ontology
      const existing = await this.collections.ontology.findOne({_id: resource._id});
      if (existing) {
        return true;
      }
      return false;
    }

    const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];

    // Support both compacted (e.g., "owl:Class") and expanded (e.g., "http://www.w3.org/2002/07/owl#Class") forms
    const ontologyTypes = [
      "owl:Class", "http://www.w3.org/2002/07/owl#Class",
      "rdfs:Class", "http://www.w3.org/2000/01/rdf-schema#Class",
      "rdfs:Datatype", "http://www.w3.org/2000/01/rdf-schema#Datatype",
      "owl:ObjectProperty", "http://www.w3.org/2002/07/owl#ObjectProperty",
      "owl:DatatypeProperty", "http://www.w3.org/2002/07/owl#DatatypeProperty",
      "owl:AnnotationProperty", "http://www.w3.org/2002/07/owl#AnnotationProperty",
      "rdf:Property", "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property",
      "owl:Ontology", "http://www.w3.org/2002/07/owl#Ontology",
      "owl:Restriction", "http://www.w3.org/2002/07/owl#Restriction",
      "owl:FunctionalProperty", "http://www.w3.org/2002/07/owl#FunctionalProperty",
      "owl:InverseFunctionalProperty", "http://www.w3.org/2002/07/owl#InverseFunctionalProperty"
    ];

    return types.some(type => ontologyTypes.includes(type));
  }

  /**
   * Determine if a resource is an owl:Ontology resource
   * Used for dcterms:isPartOf detection in importData
   * @private
   */
  _isOntologyResource(resource) {
    if (!resource["@type"]) {
      return false;
    }

    const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];

    // Support both compacted and expanded forms
    const ontologyTypes = [
      "owl:Ontology", "http://www.w3.org/2002/07/owl#Ontology"
    ];

    return types.some(type => ontologyTypes.includes(type));
  }

  /**
   * Extract context and resources from JSON-LD input
   * Handles both @graph format and array format
   * Merges all contexts found in array items like CTB Ontology.importContext
   * @private
   */
  _extractContextAndResources(jsonldData) {
    let extractedContext = null;
    let resources = [];

    if (Array.isArray(jsonldData)) {
      // Array format - collect all contexts and merge them
      const foundContexts = [];

      for (const item of jsonldData) {
        // this is a special accommodation of legacy ontology.json,
        // which is an array with an item
        //  {
        //     "_id": "@context",
        //     "@context": { ...
        if (item["@context"]) {
          foundContexts.push(item["@context"]);
        }
        else {
          resources.push(item);
        }
      }

      // Merge all found contexts using the same strategy as _importContext
      if (foundContexts.length > 0) {
        extractedContext = {};
        for (const contextData of foundContexts) {
          extractedContext = _.assignWith(extractedContext, contextData, this._contextAssignCustomizer.bind(this));
        }
      }
    }
    else if (jsonldData["@graph"]) {
      // @graph format
      extractedContext = jsonldData["@context"] || null;
      resources = jsonldData["@graph"] || [];
    }
    else {
      // Single resource
      resources = [jsonldData];
    }

    return { extractedContext: extractedContext, resources };
  }

  /**
   * Import context into Context collection with sophisticated merge strategy
   * Merges new context data with existing context using specialized conflict resolution
   * In BOLD, the context document contains the context data directly (no nested @context)
   * @private
   */
  async _importContext(contextData, contextCollection) {
    check(contextData, Object);

    // Get existing context from the Context collection, or start with Ontologize.DEFAULT_CONTEXT
    let existingContext = Ontologize.DEFAULT_CONTEXT;
    let existingContextDoc = await contextCollection.findOne({ _id: "@id" });

    // Extract existing context data
    if (existingContextDoc) {
      existingContext = { ...existingContextDoc };
    }

    // Merge the contexts using specialized merge strategy
    const mergedContext = _.assignWith(existingContext, contextData, this._contextAssignCustomizer.bind(this));

    // _id is meaningful in the json-ld context, but it gets put back later
    // this is a trick to put _id at the top of the object. ?worth it?
    delete mergedContext._id;
    // Sort context keys for consistent ordering
    const sortedContext = this._sortContextKeys(mergedContext);

    // Update the context document with merged context data directly
    await contextCollection.replaceOne(
      { _id: "@id" },
      { _id: "@id", ...sortedContext },
      { upsert: true }
    );
  }


  /**
   * Process a single resource with BOLD normalization using LD.compact
   * @private
   */
  async _normalizeAndSaveResource(resource, incomingContext, collection, contextCollection, opts) {
    const {
      normalize = true,
      ontologize = true,
      shareTBox = false,
      shareStatements = false,
      ensureArrayProps = true,
      mergeResources = true,
      beforeSaveFn = null,
      useNamespaceCollections = true,
      addIsPartOf = true,
      leadingOntologyIds = []
    } = opts;
    const ontologyCollection = this.collections.ontology;
    const statementsCollection = this.collections.statements;

    let processedResource = { ...resource };
    let isTBoxResource = false;
    let isStatementResource = false;

    // Step 1: Normalize resource using LD.compact if requested
    if (normalize) {
      const ld = this.ld();

      // Step 1-a: Stringify bold:JSON/bui:Schema property values before JSON-LD processing
      // This prevents the JSON-LD processor from altering nested POJO structure
      // useCache: false is necessary because cache keeps updating as we add new resources
      processedResource = await this._stringifyJsonProperties(processedResource, {useCache: false});

      processedResource = this._removeCommentProperties(processedResource);

      // Step 1-b: expand resource with its own context
      if (incomingContext) {
        processedResource = await ld.expand(processedResource, incomingContext);
      }

      // Get context for compaction (provided, from Context collection, or default)
      const contextForCompaction = await this.getContext();
      try {
        const compacted = await ld.compact(processedResource, contextForCompaction, {
          ensureArrayProps: ensureArrayProps,
          ensureSafeKeys: true,
          showContext: false,
          proxy: false // this is important! so that we don't persist the proxy-modified content
        });

        // Handle the case where compact returns an array or @graph
        if (Array.isArray(compacted)) {
          processedResource = compacted[0] || processedResource;
        }
        else if (compacted["@graph"]) {
          processedResource = compacted["@graph"][0] || processedResource;
        }
        else {
          processedResource = compacted;
        }
      }
      catch (error) {
        console.warn(`Failed to compact resource ${resource._id || resource["@id"]}: ${error.message}`);
      }

      // Step 1-c: Parse bold:JSON/bui:Schema property values back to POJOs for MongoDB storage
      processedResource = await this._parseJsonProperties(processedResource);
    }

    // Step 2: Ensure @type is array. This _should be
    if (ensureArrayProps && processedResource["@type"] && !Array.isArray(processedResource["@type"])) {
      processedResource["@type"] = [processedResource["@type"]];
    }

    // Step 3: Convert @id to _id for MongoDB storage
    if (processedResource["@id"] && !processedResource._id) {
      processedResource._id = processedResource["@id"];
      delete processedResource["@id"];
    }

    // Step 4: Validate that resource has an identifier
    if (!processedResource._id) {
      throw new Error("Resource must have _id or @id for MongoDB storage");
    }

    // Step 5: Classify as TBox/ABox resource
    if (ontologize) {
      isTBoxResource = await this.isTBoxResource(processedResource);
    }

    // Step 5.5: Detect Statement resources
    isStatementResource = this.isStatementResource(processedResource);

    // Step 5.6: If Statement, ensure @type includes "rdf:Statement"
    if (isStatementResource) {
      if (!processedResource["@type"]) {
        processedResource["@type"] = ["rdf:Statement"];
      }
      else {
        const types = Array.isArray(processedResource["@type"])
          ? processedResource["@type"]
          : [processedResource["@type"]];

        // Check if rdf:Statement is already present (compacted or expanded form)
        const hasStatementType = types.some(type =>
          type === "rdf:Statement" ||
          type === "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement"
        );

        if (!hasStatementType) {
          processedResource["@type"] = [...types, "rdf:Statement"];
        }
      }
    }

    // Step 5.7: Handle property context updates (@type and @container)
    if (ensureArrayProps && this._isPropertyResource(processedResource)) {
      await this.ensurePropertyContext(processedResource, contextCollection);
    }

    // Step 5.75: Add dcterms:isPartOf for non-ontology resources
    // This indicates which owl:Ontology resources the resource is part of
    if (addIsPartOf && leadingOntologyIds.length > 0 && !this._isOntologyResource(processedResource)) {
      // Get existing isPartOf values (if any) and merge with leading ontology IDs
      let existingIsPartOf = processedResource["dcterms:isPartOf"];
      if (existingIsPartOf) {
        if (!Array.isArray(existingIsPartOf)) {
          existingIsPartOf = [existingIsPartOf];
        }
      }
      else {
        existingIsPartOf = [];
      }
      // Merge using union to avoid duplicates
      processedResource["dcterms:isPartOf"] = _.union(existingIsPartOf, leadingOntologyIds);
    }

    // Step 5.8: Call beforeSaveFn if provided for filtering/adornment
    if (beforeSaveFn) {
      // Support both sync and async beforeSaveFn
      const modifiedResource = await Promise.resolve(beforeSaveFn(processedResource));

      // If beforeSaveFn returns falsey, skip this resource
      if (!modifiedResource) {
        return {
          success: true,
          skipped: true,
          isTBox: isTBoxResource,
          isStatement: isStatementResource,
          resource: processedResource
        };
      }

      // Use the modified resource for saving
      processedResource = modifiedResource;
    }

    // Step 6: Save to appropriate collection(s)

    // if this is destined for an ABox collection,
    if (!isTBoxResource || shareTBox) {
      let _collection;
      const defaultAboxCollection = this.opts.typeCollections?.["*"];
      if (this.opts.typeCollections) {
        /*
        const example = {
          "typeCollections": {
            "bold:Animal": "animal",
            "orju:Bird": "animal"
          }
        }
        */
        for (const typ of (processedResource["@type"] ?? [])) {
          if (_collection) {
            // stick with the first found
            continue;
          }
          const colName = this.opts.typeCollections[typ];
          if (colName) {
            _collection = this.collections[colName];
            if (_collection) {
              // console.log(`using typeCollection "${colName}" for ${processedResource._id} @type: ${typ}`);
            }
            else {
              console.error(`Unknown typeCollection "${typ}"`);
            }
          }
        }
      }
      if (!_collection) {
        const prefix = processedResource._id.match(/^([^:]+):/)?.[1];
        if (prefix) {
          // do we have idResolvers for this prefix in our opts?
          if (this.opts.idResolvers?.[prefix]) {
            const resolvers = this.opts.idResolvers[prefix];
            if (Array.isArray(resolvers)) {
              for (const resolver of resolvers) {
                if (_collection) {
                  continue;
                }
                if (resolver.match) {
                  const re = new RegExp(resolver.match);
                  if (processedResource._id.match(re) && resolver.collection) {
                    // resolver.collection will be the registered name of the collection
                    if (this.collections[resolver.collection]) {
                      _collection = this.collections[resolver.collection];
                    }
                  }
                }
              }
            }
          }
          if (!_collection && useNamespaceCollections) {
            const namespaceCollection = this.collections[prefix];
            if (namespaceCollection) {
              _collection = namespaceCollection;
            }
          }
        }
      }
      // after checking for type, _id, and namespace, use default if there is one
      if (!_collection && defaultAboxCollection && this.collections[defaultAboxCollection]) {
        _collection = this.collections[defaultAboxCollection];
        // console.log(`using ABox Collection "${defaultAboxCollection}" for ${processedResource._id} @type: ${processedResource["@type"]}`);
      }
      // if we found a type, _id, namespace, or default collection, use it
      if (_collection) {
        collection = _collection;
      }
    }

    if (isStatementResource && statementsCollection) {
      // Statement resource - save to Statements collection with merge strategy
      await this._saveResourceWithMerge(processedResource, statementsCollection, { mergeResources });

      // Also save to target collection if shareStatements is true
      if (shareStatements && collection !== statementsCollection) {
        await collection.replaceOne(
          { _id: processedResource._id },
          processedResource,
          { upsert: true }
        );
      }
    }
    else if (isTBoxResource || collection === ontologyCollection) {
      // TBox resource - save to Ontology collection with merge strategy.
      await this._saveResourceWithMerge(processedResource, ontologyCollection, { mergeResources });

      // Also save to main collection if shareTBox is true,
      // But not if the collection we're importing into is the ontologyCollection,
      // cause we already did that above.
      if (shareTBox && collection !== ontologyCollection) {
        await collection.replaceOne(
          { _id: processedResource._id },
          processedResource,
          { upsert: true }
        );
      }
    }
    else {
      // ABox resource - save to main collection
      if (!collection) {
        console.log(`no collection found for ${processedResource._id} with @type ${JSON.stringify(processedResource["@type"])}. Using ontology.`);
        collection = ontologyCollection;
      }
      await collection.replaceOne(
        { _id: processedResource._id },
        processedResource,
        { upsert: true }
      );
    }

    return {
      success: true,
      isTBox: isTBoxResource,
      isStatement: isStatementResource,
      resource: processedResource
    };
  }

  /**
   * Customizer function for merging context objects with specialized conflict resolution
   * Handles namespace conflicts intelligently based on BOLD/CTB patterns
   * @private
   */
  _contextAssignCustomizer(objValue, srcValue, key) {
    // If original objValue exists and is different from new srcValue, we have a conflict
    if (objValue && !_.isEqual(objValue, srcValue)) {
      // Handle specific known namespace conflicts
      if (key === "dc" && srcValue === "http://purl.org/dc/elements/1.1/") {
        console.warn(`Context conflict for ${key}, old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}. Using new value.`);
        return undefined; // Let lodash use the new value
      }

      if (key === "ctb" && srcValue === "https://ontology.2wav.com/bridge#") {
        console.warn(`Context conflict for ${key}, old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}. Keeping existing value.`);
        return objValue; // Keep the existing value
      }

      if (key === "dcterms") {
        console.warn(`Context conflict for ${key}, old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}. Using canonical value.`);
        return "http://purl.org/dc/terms/"; // Use canonical value
      }

      // BOLD namespace handling - prefer BOLD over CTB
      if (key === "bold" || (key === "ctb" && srcValue.includes("bold"))) {
        console.warn(`Context conflict for ${key}, preferring BOLD namespace. old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)}`);
        return srcValue; // Prefer BOLD namespace
      }

      // If both are objects, merge them recursively
      if (_.isObject(objValue) && _.isObject(srcValue)) {
        const merged = _.mergeWith(objValue, srcValue, this._schemaMergeCustomizer);
        console.info(`Context resolution for ${key}, merging objects. old=${JSON.stringify(objValue)} new=${JSON.stringify(srcValue)} result=${JSON.stringify(merged)}`);
        return merged;
      }

      // For any other conflicting combination, throw an error
      throw new Error(`Namespace conflict for ${key}: existing=${JSON.stringify(objValue)} vs new=${JSON.stringify(srcValue)}`);
    }

    // No conflict, let lodash handle the default assignment
    return undefined;
  }

  /**
   * Schema merge customizer for handling array merging in contexts
   * Ensures arrays are properly merged using union to avoid duplicates
   * @private
   */
  _schemaMergeCustomizer(objValue, srcValue, _key, _object, _source, _stack) {
    // Ensure we merge arrays from either side
    if (_.isArray(objValue) || _.isArray(srcValue)) {
      // Handle null/undefined values
      if (objValue === null || objValue === undefined) {
        objValue = [];
      }
      if (srcValue === null || srcValue === undefined) {
        srcValue = [];
      }

      // Convert non-arrays to arrays when one side is an array
      if (!_.isArray(objValue)) {
        objValue = [objValue];
      }
      if (!_.isArray(srcValue)) {
        srcValue = [srcValue];
      }

      // Use union to merge arrays and remove duplicates
      return _.union(objValue, srcValue);
    }

    // For non-arrays, let lodash use default behavior
    return undefined;
  }

  /**
   * Save a resource to a collection with intelligent merge strategy
   * Similar to CTB Ontology.updateOntology, merges with existing resources to preserve data
   * @private
   */
  async _saveResourceWithMerge(resource, collection, opts = {}) {
    const { mergeResources = true } = opts;
    check(resource, Object);
    check(collection, Object);

    if (!resource._id) {
      throw new Error("Resource must have _id for MongoDB storage");
    }

    // Check if a resource with this _id already exists
    const existingResource = await collection.findOne({ _id: resource._id });

    if (existingResource && mergeResources) {
      // Merge existing resource with new resource using schema merge strategy
      // Clone the existing resource to avoid modifying the original
      const mergedResource = _.mergeWith(_.cloneDeep(existingResource), resource, this._schemaMergeCustomizer.bind(this));

      // Update the existing resource with merged data
      await collection.replaceOne(
        { _id: resource._id },
        mergedResource,
        { upsert: true }
      );
    }
    else {
      // Either no existing resource, or mergeResources is false - just replace
      await collection.replaceOne(
        { _id: resource._id },
        resource,
        { upsert: true }
      );
    }
  }

  /**
   * Sort context keys for consistent ordering
   * Places @-prefixed keys first, then namespaces (no colon), then prefixed terms
   * @private
   */
  _sortContextKeys(context) {
    const sortedKeys = Object.keys(context).sort((a, b) => {
      // Check if keys are namespace declarations (no colon)
      const aNamespace = !a.includes(":");
      const bNamespace = !b.includes(":");

      // Namespaces sort before prefixed terms
      if (aNamespace !== bNamespace) {
        return aNamespace ? -1 : 1;
      }

      // @-prefixed keys (like @vocab, @base) sort to the front
      if (a[0] === "@" && b[0] !== "@") {
        return -1;
      }
      if (b[0] === "@" && a[0] !== "@") {
        return 1;
      }

      // Standard lexical sorting
      return a.localeCompare(b);
    });

    // Rebuild the context object with sorted keys
    const sortedContext = {};
    for (const key of sortedKeys) {
      sortedContext[key] = context[key];
    }

    return sortedContext;
  }

  /**
   * Get all properties from the ontology grouped by their types
   * @private
   */
  async _getAllPropertiesGroupedByType() {
    const propertiesGrouped = {
      ObjectProperties: {},
      DatatypeProperties: {},
      AnnotationProperties: {},
      Properties: {}
    };

    // Get all property resources from the ontology
    const cursor = this.collections.ontology.find({
      "@type": {
        $in: ["owl:ObjectProperty", "owl:DatatypeProperty", "owl:AnnotationProperty", "rdf:Property"]
      }
    });
    const properties = await cursor.toArray();

    for (const property of properties) {
      const types = Array.isArray(property["@type"]) ? property["@type"] : [property["@type"]];

      // Determine which category this property belongs to
      if (types.includes("owl:ObjectProperty")) {
        propertiesGrouped.ObjectProperties[property._id] = property;
      }
      else if (types.includes("owl:DatatypeProperty")) {
        propertiesGrouped.DatatypeProperties[property._id] = property;
      }
      else if (types.includes("owl:AnnotationProperty")) {
        propertiesGrouped.AnnotationProperties[property._id] = property;
      }
      else if (types.includes("rdf:Property")) {
        propertiesGrouped.Properties[property._id] = property;
      }
    }

    return propertiesGrouped;
  }

  /**
   * Get all ontology resources from the ontology collection
   * @private
   */
  async _getAllOntologies() {
    const ontologies = {};
    const cursor = this.collections.ontology.find({
      "@type": { $in: ["owl:Ontology"] }
    });
    const ontologyResources = await cursor.toArray();

    for (const ontologyResource of ontologyResources) {
      ontologies[ontologyResource._id] = ontologyResource;
    }

    return ontologies;
  }

  /**
   * Helper function to get the first element of an array or return the value if not an array
   * Equivalent to CTB's first() function
   * @private
   */
  _first(arrayOrVal) {
    if (Array.isArray(arrayOrVal)) {
      if (arrayOrVal.length) {
        return arrayOrVal[0];
      }
      return undefined;
    }
    return arrayOrVal;
  }

  /**
   * Convert BFO resources from Ontology into a triples format that can be inserted into SPARQL
   * Similar to CTB's Ontology.getTriplesForResources but adapted for BOLD
   *
   * @param {object|Array<object>} resources - Resource(s) to convert to triples
   * @param {object} [opts] - Options
   * @param {object} [opts.context] - JSON-LD context for expansion
   * @param {boolean} [opts.blankNodes=true] - Allow blank nodes
   * @param {boolean} [opts.includeStatements=false] - Include embedded statements (for BOLD, skip by default)
   * @returns {Promise<Array<{s: string, p: string, o: string}>>} Array of SPO triples
   */
  async getTriplesForResources(resources, opts = {}) {
    check(resources, Match.OneOf(Object, Array));
    resources = _.isArray(resources) ? resources : [resources];
    const triples = [];
    opts.blankNodes = opts.blankNodes !== false;
    opts.includeStatements = opts.includeStatements ?? false;

    // For BOLD, we generally don't want to create triples for embedded statements
    // In BOLD, we use "bold:" namespace instead of "ctb:"
    if (!opts.includeStatements) {
      for (const r of resources) {
        this._stripEmbeddedStatements(r);
      }
    }

    // Strip properties with JSON values — they cannot be represented as triples
    for (const r of resources) {
      for (const key of Object.keys(r)) {
        if (key[0] === "@" || key === "_id") continue;
        if (await this._isJsonProperty(key)) {
          delete r[key];
        }
      }
    }

    // Get the context from the Context collection (which should have _id: "@id" mapping)
    const contextForExpansion = await this.getContext(opts.context);

    const ld = this.ld();
    const expanded = await ld.expand(resources, contextForExpansion, { flatten: true });
    expanded.forEach((resource) => {
      for (const key in resource) {
        let p = key;
        if (key === "@type") {
          p = OntologizeServer.TYPE_URI;
        }
        else if (key[0] === "@") {
          // ignore all others like @context
          continue;
        }
        if (!opts.blankNodes && key[0] === "_") {
          // ignore these including _id
          continue;
        }
        if (!opts.includeStatements) {
          if (key === "bold:subjectOfStatement" || key === "bold:objectOfStatement") {
            // don't triplize embedded statements.
            continue;
          }
        }
        const values = _.isArray(resource[key]) ? resource[key] : [resource[key]];
        values.forEach((v) => {
          if (typeof v === "object") {
            if (Object.prototype.hasOwnProperty.call(v, "@id")) {
              v = v["@id"];
            }
            else if (Object.prototype.hasOwnProperty.call(v, "@value")) {
              v = v["@value"];
            }
            else {
              // what's this?
              console.log(`can't convert property value ${JSON.stringify(v)} to triple.`);
              return;
            }
          }
          triples.push({
            s: resource["@id"],
            p: p,
            o: v
          });
        });
      }
    });
    return triples;
  }

  /**
   * Create a SPARQL "INSERT DATA" query from triples
   * Similar to CTB's Ontology.insertTriples but returns the SPARQL string instead of executing it
   *
   * @param {Array<{s: string, p: string, o: string}>} triples - Array of SPO triples
   * @param {object} [opts] - Options
   * @param {object} [opts.context] - JSON-LD context for prefixes (optional - will use basic prefixes if not provided)
   * @returns {Promise<string>} SPARQL INSERT DATA query string
   */
  async createSparqlInsert(triples, opts = {}) {
    check(triples, Array);
    check(opts, Object);

    if (triples.length === 0) {
      return "# No triples to insert";
    }

    // Get context and build complete SPARQL prefixes from it
    const context = await this.getContext(opts.context);

    // Build SPARQL PREFIX declarations from context
    let prefixes = "";
    for (const [key, value] of Object.entries(context)) {
      // Skip JSON-LD keywords and non-string values (complex term definitions)
      if (key.startsWith("@") || key === "_id" || typeof value !== "string") {
        continue;
      }
      // Only include if the value looks like a namespace URI
      if (value.startsWith("http://") || value.startsWith("https://")) {
        prefixes += `PREFIX ${key}: <${value}>\n`;
      }
    }

    let sparql = `${prefixes}
INSERT DATA {
`;

    // Format each triple for SPARQL
    triples.forEach((triple, index) => {
      // Format subject
      const s = this._formatSparqlTerm(triple.s);

      // Format predicate
      const p = this._formatSparqlTerm(triple.p);

      // Format object
      const o = this._formatSparqlTerm(triple.o);

      // Add the triple line
      if (index === triples.length - 1) {
        // Last triple - no dot
        sparql += `  ${s} ${p} ${o}
`;
      }
 else {
        // Not last triple - add dot
        sparql += `  ${s} ${p} ${o} .
`;
      }
    });

    sparql += `}
`;

    return sparql;
  }

  /**
   * Format a term for SPARQL (wrap URIs in <>, quote literals)
   * @param {string} value - The term to format
   * @returns {string} Formatted term for SPARQL
   * @private
   */
  _formatSparqlTerm(value) {
    switch (typeof value) {
      case "number":
      case "boolean":
        return value;
      default:
    }

    if (typeof value !== "string") {
      return `"${value}"`;
    }

    // Check if it's a valid full URI - must be a proper URI without spaces or invalid characters
    // URI pattern: scheme://authority/path (no spaces, must end before whitespace)
    if (/^https?:\/\/[^\s<>"{}|\\^`[\]]+$/.test(value)) {
      return `<${value}>`;
    }

    // Check if it's a valid prefixed name (QName)
    if (this._isValidPrefixedName(value)) {
      return value;
    }

    // Otherwise, treat as a literal and quote it
    // Escape backslashes first, then quotes, then whitespace characters
    const escapedTerm = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escapedTerm}"`;
  }

  /**
   * Transform HyLAR facts into JSON-LD resources
   * Similar to CTB's Ontology.assembleFactsIntoResources but simplified for BOLD
   * Groups facts by subject, creates JSON-LD objects, and compacts them
   *
   * @param {Array} facts - Array of HyLAR facts from reasoning derivations
   * @param {object} [opts] - Options
   * @param {object} [opts.context] - JSON-LD context for compaction
   * @param {boolean} [opts.compact=true] - Whether to compact the resources
   * @returns {Promise<object>} Dictionary of resources keyed by _id
   */
  async assembleFactsIntoResources(facts, opts = {}) {
    check(facts, Array);
    check(opts, Object);

    const context = await this.getContext(opts.context);
    const compact = opts.compact !== false;

    console.log(`🔄 Assembling ${facts.length} facts into JSON-LD resources...`);

    const resources = {};

    // Step 1: Group facts by subject into JSON-LD objects
    facts.forEach(fact => {
      // HACKERY
      // for reasons unknown at the moment, string values are coming across quoted...
      let rr = fact.subject.match(/^"(.*)"$/s);
      if (rr) {
        console.log(`fact.subject ${fact.subject} appears quoted.`);
        fact.subject = rr[1];
      }
      rr = fact.object.match(/^"(.*)"$/s);
      if (rr) {
        console.log(`fact.object for ${fact.subject} appears quoted:`, fact.object);
        fact.object = rr[1];
      }
      // Skip facts that don't have proper structure
      if (!fact.subject || !fact.predicate) {
        return;
      }

      // Get or create resource for this subject
      if (!resources[fact.subject]) {
        resources[fact.subject] = {
          _id: fact.subject
        };
      }

      const resource = resources[fact.subject];
      const predicate = fact.predicate;
      const object = this._convertXsdLiteral(fact.object);

      // Add the property value
      if (typeof resource[predicate] === "undefined") {
        // First value for this predicate
        resource[predicate] = [object];
      }
 else {
        // Additional value - ensure it's an array and add if not duplicate
        if (!Array.isArray(resource[predicate])) {
          resource[predicate] = [resource[predicate]];
        }
        if (resource[predicate].indexOf(object) === -1) {
          resource[predicate].push(object);
        }
      }
    });

    console.log(`📊 Grouped facts into ${Object.keys(resources).length} resources`);

    // Step 2: Compact resources if requested
    if (compact) {
      console.log(`🗜️ Compacting ${Object.keys(resources).length} resources...`);
      const compactedResources = {};

      const ld = this.ld();
      const compactPromises = Object.values(resources).map(resource =>
        ld.compact(resource, context, {
          showContext: false,
          proxy: false,
          ensureArrayProps: true,
          ensureSafeKeys: true
        })
      );

      const compacted = await Promise.all(compactPromises);
      compacted.forEach(resource => {
        compactedResources[resource._id] = resource;
      });

      console.log(`✅ Assembled and compacted ${Object.keys(compactedResources).length} resources from facts`);
      return compactedResources;
    }
 else {
      console.log(`✅ Assembled ${Object.keys(resources).length} resources from facts (uncompacted)`);
      return resources;
    }
  }

  /**
   * Create Statement objects from HyLAR reasoning facts
   * @param {Object[]} facts - Array of HyLAR fact objects
   * @param {Object} opts - Options
   * @param {Object} opts.context - JSON-LD context for URI compaction
   * @param {Object} opts.metaPropsByPredicate - Additional metadata properties by predicate
   * @param {boolean} opts.onlyInferred - Only process inferred facts (default: true)
   * @param {string[]} opts.onlySubjects - Only process facts for these subjects
   * @param {boolean} opts.onlyNew - Filter out existing statements (default: false)
   * @returns {Promise<Object[]>} Array of Statement objects
   */
  async createStatementsForFacts(facts, opts = {}) {
    check(facts, Array);
    check(opts, Match.Optional(Object));

    opts = {
      onlyInferred: opts.onlyInferred !== false,
      onlyNew: opts.onlyNew || false,
      metaPropsByPredicate: opts.metaPropsByPredicate || {},
      ...opts
    };

    console.log(`Creating statements for ${facts.length} facts`);

    const context = opts.context || await this.getContext();
    const statements = [];
    let processedCount = 0;

    // Create an LD instance for URI compaction
    const ld = this.ld();

    for (const fact of facts) {
      if (processedCount % 1000 === 0 && processedCount > 0) {
        console.log(`Processed fact ${processedCount + 1} of ${facts.length}`);
      }
      processedCount++;

      // Skip explicit facts if onlyInferred is true
      if (opts.onlyInferred && fact.explicit) {
        continue;
      }

      // Filter by subjects if specified
      if (opts.onlySubjects) {
        const compactSubject = ld.compactUri(fact.subject, context);
        if (!opts.onlySubjects.includes(compactSubject)) {
          continue;
        }
      }

      try {
        // Skip invalid facts
        const tripleStr = fact.asString;
        if (!tripleStr) {
          console.error("What kind of fact doesn't have asString?",fact.subject,fact.predicate,fact.object);
          continue;
        }
        if (tripleStr === "IFALSE") {
          console.error("INCONSISTENT FACT:", fact);
          continue;
        }
        if (tripleStr.match(/^[IE]\("/)) {
          // Skip weird string subjects from HyLAR
          continue;
        }

        // Parse the fact string to extract components
        const rr = tripleStr.match(/^(I|E)\((\S+), ?(\S+), ?([\s\S]*)\)/m);
        if (!rr) {
          console.error("Skip HyLAR result parse error:", tripleStr);
          continue;
        }

        const inferred = rr[1] === "I";
        const sUri = rr[2];
        const pUri = rr[3];
        let oUri = rr[4];

        // Convert literals like "RA-8"^^<http://www.w3.org/2001/XMLSchema#string>
        oUri = this._convertLiteral(oUri);

        // Create statement metadata
        const allPreds = opts.metaPropsByPredicate["*"] || {};
        const statement = {
          "@type": ["rdf:Statement"],
          "rdf:subject": ld.compactUri(sUri, context),
          "rdf:predicate": ld.compactUri(pUri, context),
          "rdf:object": ld.compactUri(oUri, context),
          "bold:when": allPreds["bold:when"] || new Date().toISOString(),
          "bold:scope": allPreds["bold:scope"] || "bold:system"
        };

        // Add optional metadata
        if (allPreds["rdfs:comment"]) {
          statement["rdfs:comment"] = allPreds["rdfs:comment"];
        }
        if (allPreds["bold:createdBy"]) {
          statement["bold:createdBy"] = allPreds["bold:createdBy"];
        }

        // Add predicate-specific metadata
        const predProps = opts.metaPropsByPredicate[statement["rdf:predicate"]];
        if (predProps) {
          Object.keys(predProps).forEach((metaPred) => {
            statement[metaPred] = predProps[metaPred];
          });
        }

        // Generate unique ID
        const randomKey = Math.random().toString(36).substring(2, 8);
        const statementId = ld.kebabCase(`${statement["rdf:subject"]}-${statement["rdf:predicate"]}-${statement["rdf:object"]}-${randomKey}`);
        statement._id = `bold:${statementId}`;

        if (!fact.explicit && fact.rule) {
          statement["bold:inferredFrom"] = [fact.rule.object, fact.rule.predicate, fact.rule.subject, fact.rule.axiom, "bold:reasoner"];
          statement["bold:explanation"] = `Inferred by reasoner, based on ${fact.rule.subject} ${fact.rule.predicate} ${fact.rule.object}`;
          statement._details = fact.rule.details;
        }
        statements.push(statement);
      }
      catch (err) {
        console.error(err);
      }
    }

    console.log(`Created ${statements.length} statements from ${facts.length} facts`);

    // Filter out existing statements if onlyNew is true
    if (opts.onlyNew && this.collections.statements) {
      console.log("Filtering out existing statements...");
      const newStatements = [];

      for (const statement of statements) {
        const existing = await this.collections.statements.findOne({
          "rdf:subject": statement["rdf:subject"],
          "rdf:object": statement["rdf:object"],
          "rdf:predicate": statement["rdf:predicate"],
          "bold:inferredFrom": statement["bold:inferredFrom"]
        });

        if (!existing) {
          newStatements.push(statement);
        }
      }

      console.log(`Filtered ${statements.length} statements to ${newStatements.length} new statements`);
      return newStatements;
    }

    return statements;
  }

  /**
   * Convert HyLAR literal values to proper format
   * @param {string} literal - The literal string from HyLAR
   * @returns {string} Converted literal
   * @private
   */
  _convertLiteral(literal) {
    if (!literal) return literal;

    try {
      // Handle typed literals like "RA-8"^^<http://www.w3.org/2001/XMLSchema#string>
      const typedMatch = literal.match(/^"(.*)"\^\^<(.*)>$/);
      if (typedMatch) {
        return typedMatch[1]; // Return just the value for now
      }
      // Handle language tagged literals like "pertenece a la clasificación"@es
      const langMatch = literal.match(/^"(.*)"@(.*)$/);
      if (langMatch) {
        return langMatch[1]; // Return just the value for now
      }

      // Handle quoted strings
      if (literal.startsWith('"') && literal.endsWith('"')) {
        return literal.slice(1, -1);
      }
    }
    catch (e) {
      console.error("_convertLiteral error",e);
    }


    return literal;
  }

  /**
   * Convert XSD typed literals to JavaScript primitive values.
   * Boolean and numeric XSD types are converted to their JS equivalents.
   * String, date, and other types are returned as plain strings (type annotation stripped).
   * Non-literal values are returned unchanged.
   *
   * @param {string} value - The fact object value, possibly an XSD literal
   * @returns {boolean|number|string} The converted value
   * @private
   */
  _convertXsdLiteral(value) {
    if (!value || typeof value !== "string") return value;

    const XSD = "http://www.w3.org/2001/XMLSchema#";

    // Match typed literals: "value"^^<URI> or "value"^^URI
    const match = value.match(/^"(.*)"\^\^<?([^>]*)>?$/);
    if (!match) return value;

    const [, lexical, datatype] = match;
    const xsdType = datatype.startsWith(XSD) ? datatype.slice(XSD.length) : null;

    if (!xsdType) return lexical;

    switch (xsdType) {
      case "boolean":
        return lexical === "true";
      case "integer":
        return parseInt(lexical, 10);
      case "decimal":
      case "double":
      case "float":
        return parseFloat(lexical);
      default:
        return lexical;
    }
  }

  /**
   * Check if a term is a valid prefixed name (QName) for SPARQL
   * @param {string} term - The term to check
   * @returns {boolean} True if it's a valid prefixed name
   * @private
   */
  _isValidPrefixedName(term) {
    // Must contain exactly one colon
    const colonIndex = term.indexOf(":");
    if (colonIndex === -1 || term.indexOf(":", colonIndex + 1) !== -1) {
      return false;
    }

    // Must not start with colon
    if (colonIndex === 0) {
      return false;
    }

    const prefix = term.substring(0, colonIndex);
    const localName = term.substring(colonIndex + 1);

    // Check if prefix looks like a valid namespace prefix (letters, numbers, underscore)
    // Common prefixes: rdf, rdfs, owl, bfo, bold, foaf, dc, etc.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) {
      return false;
    }

    // Local name can be empty or contain valid characters
    // Allow letters, numbers, hyphens, underscores, dots
    if (localName && !/^[a-zA-Z0-9_.-]*$/.test(localName)) {
      return false;
    }

    // Additional check: reject if it looks like a file path, URL scheme, or other non-QName pattern
    const knownNonPrefixes = [
      "file", "ftp", "mailto", "tel", "urn",
      "data", "javascript", "about"
    ];

    if (knownNonPrefixes.includes(prefix.toLowerCase())) {
      return false;
    }

    return true;
  }

  /**
   * Strip embedded statements from resource to avoid triplizing them
   * BOLD version of CTB's stripEmbeddedStatements
   * @param {object} resource - Resource to strip statements from
   * @private
   */
  _stripEmbeddedStatements(resource) {
    check(resource, Object);
    const subjectOfPaths = jsonPath(resource, "$..['bold:subjectOfStatement']", { resultType: "PATH" });
    const objectOfPaths = jsonPath(resource, "$..['bold:objectOfStatement']", { resultType: "PATH" });
    const $ = resource;
    const paths = [].concat(subjectOfPaths || [], objectOfPaths || []);
    for (const path of paths) {
      // eslint-disable-next-line no-eval
      eval(`delete ${path}`);
    }
  }

  /**
   * Helper function to check if a resource has a specific @type
   * Equivalent to CTB's is() function
   * @private
   */
  _is(resArrayOrVal, typ) {
    typ = Array.isArray(typ) ? typ : [typ];

    if (_.isObjectLike(resArrayOrVal)) {  // i.e., not null
      if (resArrayOrVal["@type"]) {
        resArrayOrVal = resArrayOrVal["@type"];
      }
    }

    resArrayOrVal = Array.isArray(resArrayOrVal) ? resArrayOrVal : [resArrayOrVal];
    return !!_.intersection(resArrayOrVal, typ).length;
  }

  /**
   * Check if a resource is a property (RDF/OWL property)
   * @param {Object} resource - The resource to check
   * @returns {boolean} True if the resource is a property
   * @private
   */
  _isPropertyResource(resource) {
    if (!resource["@type"]) {
      return false;
    }

    const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];
    const propertyTypes = [
      "rdf:Property",
      "owl:ObjectProperty",
      "owl:DatatypeProperty",
      "owl:AnnotationProperty",
      "owl:FunctionalProperty",
      "owl:InverseFunctionalProperty",
      "owl:TransitiveProperty",
      "owl:SymmetricProperty",
      "owl:AsymmetricProperty",
      "owl:ReflexiveProperty",
      "owl:IrreflexiveProperty"
    ];

    return types.some(type => propertyTypes.includes(type));
  }

  /**
   * Determine the appropriate @type value for a property's context entry
   * based on its OWL type and rdfs:range.
   *
   * @param {Object} resource - The property resource
   * @returns {string|null} The @type value for context, or null if undetermined
   * @private
   */
  async _getPropertyContextType(resource) {
    const XSD_PREFIX = "http://www.w3.org/2001/XMLSchema#";
    const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];

    // ObjectProperty → "@id"
    if (types.includes("owl:ObjectProperty")) {
      return "@id";
    }

    // DatatypeProperty → check rdfs:range for XSD type
    if (types.includes("owl:DatatypeProperty") && resource["rdfs:range"]) {
      const range = resource["rdfs:range"];
      // Expand xsd: prefix
      if (range.startsWith("xsd:")) {
        return XSD_PREFIX + range.substring(4);
      }
      // Already full XSD URI
      if (range.startsWith(XSD_PREFIX)) {
        return range;
      }
      if (range === "bold:JSON" || range === "bui:Schema") {
        return "@json";
      }
    }

    // Default for ObjectProperty-like behavior (range points to a class)
    if (resource["rdfs:range"] && !resource["rdfs:range"].startsWith("xsd:")) {
      return "@id";
    }

    if (await this._isJsonProperty(resource._id)) {
      return "@json";
    }

    return null; // No type determination possible
  }

  /**
   * BUI JSON type URIs that require special serialization handling.
   * Properties with these ranges store POJOs in MongoDB but serialize as JSON strings.
   * @private
   */
  static BUI_JSON_TYPES = [
    "bold:JSON",
    "bui:Schema",
    "bold:GeoJson",
    "bold:GeoPoint",
    "https://ontologize.2wav.com/ontology/bold#JSON",
    "https://ontologize.2wav.com/ontology/bold-ui#Schema",
    "https://ontologize.2wav.com/ontology/bold-ui#GeoJson",
    "https://ontologize.2wav.com/ontology/bold-ui#GeoPoint",
  ];

  /**
   * BUI properties that are hardwired as JSON properties. This let's JSON properties be handled correctly before all ontologies are loaded.
   * @type {[string]}
   */
  static BUI_JSON_PROPERTIES = [
    "bui:schema"
  ];

  /**
   * Check if a property has a bold:JSON or bui:Schema range (or subclass).
   * These properties require special handling during import/export.
   *
   * @param {string} propertyId - The property identifier (e.g., "bui:schema")
   * @returns {Promise<boolean>} True if the property has a JSON-type range
   * @private
   */
  async _isJsonProperty(propertyId) {
    if (!propertyId) return false;

    // Check cache first
    if (!this._jsonPropertyLookupCache) {
      this._jsonPropertyLookupCache = new Map();
    }
    if (this._jsonPropertyLookupCache.has(propertyId)) {
      return this._jsonPropertyLookupCache.get(propertyId);
    }

    // Look up property definition in Ontology collection
    const propertyDef = await this.collections.ontology.findOne({ _id: propertyId });
    if (!propertyDef) {
      this._jsonPropertyLookupCache.set(propertyId, false);
      return false;
    }

    // Check for explicit bold:isJsonProperty marker
    if (propertyDef["bold:isJsonProperty"] === true) {
      this._jsonPropertyLookupCache.set(propertyId, true);
      return true;
    }

    // Check rdfs:range
    const range = propertyDef["rdfs:range"];
    if (range && OntologizeServer.BUI_JSON_TYPES.includes(range)) {
      this._jsonPropertyLookupCache.set(propertyId, true);
      return true;
    }

    this._jsonPropertyLookupCache.set(propertyId, false);
    return false;
  }

  /**
   * Get all known JSON-type property IDs from the Ontology collection.
   * Caches results for performance.
   *
   * @returns {Promise<Set<string>>} Set of property IDs with JSON-type ranges
   * @private
   */
  async _getJsonPropertyIds(useCache = true) {
    if (!this._jsonPropertyIdsCache) {
      this._jsonPropertyIdsCache = new Set();
    }
    const jsonProps = this._jsonPropertyIdsCache;
    if (useCache && this._jsonPropertyIdsCache.size) {
      return this._jsonPropertyIdsCache;
    }

    // Find properties with bold:JSON or bui:Schema range
    const cursor = this.collections.ontology.find({
      $or: [
        { "rdfs:range": { $in: OntologizeServer.BUI_JSON_TYPES } },
        { "bold:isJsonProperty": true }
      ]
    });

    const props = await cursor.toArray();
    for (const prop of props) {
      if (prop._id) {
        jsonProps.add(prop._id);
      }
    }
    // some props are defaulted in so that we can recognize them before their actual ontology files are bootstrapped,
    // e.g. bui:schema
    for (const prop of OntologizeServer.BUI_JSON_PROPERTIES) {
      jsonProps.add(prop);
    }
    return jsonProps;
  }

  /**
   * Clear the JSON property cache (call when ontology changes)
   */
  clearJsonPropertyCache() {
    this._jsonPropertyLookupCache = null;
    this._jsonPropertyIdsCache = null;
  }

  /**
   * Pre-process a resource before JSON-LD expansion/compaction.
   * Stringifies POJO values on bold:JSON/bui:Schema properties to prevent
   * the JSON-LD processor from altering their structure.
   *
   * @param {Object} resource - The resource to process
   * @returns {Promise<Object>} Resource with JSON property values stringified
   * @private
   */
  async _stringifyJsonProperties(resource, opts = {}) {
    opts.useCache = opts.useCache !== false;
    const jsonPropertyIds = await this._getJsonPropertyIds(opts.useCache);
    if (jsonPropertyIds.size === 0) {
      return resource;
    }

    const processed = { ...resource };
    for (const propId of jsonPropertyIds) {
      if (propId in processed) {
        const value = processed[propId];
        // Only stringify if it's a POJO (not already a string)
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          processed[propId] = JSON.stringify(value);
        }
        else if (Array.isArray(value)) {
          // Handle array of POJOs
          processed[propId] = value.map(v =>
            (v !== null && typeof v === "object") ? JSON.stringify(v) : v
          );
        }
      }
    }

    return processed;
  }

  /**
   * Post-process a resource after JSON-LD expansion/compaction.
   * Parses JSON string values back to POJOs for bui:JSON/bui:Schema properties.
   *
   * @param {Object} resource - The resource to process
   * @returns {Promise<Object>} Resource with JSON property values parsed
   * @private
   */
  async _parseJsonProperties(resource) {
    const jsonPropertyIds = await this._getJsonPropertyIds();
    if (jsonPropertyIds.size === 0) {
      return resource;
    }

    const processed = { ...resource };
    for (const propId of jsonPropertyIds) {
      if (propId in processed) {
        let value = processed[propId];
        // NASTY... we can get a variety of mess from ld.compact for properties with context @type: @json, like:
        const ex = {
          "@type": [
            "@json"
          ],
          "@value": {
            "properties": {
              //...
            }
          }
        };
        // look for a { @type, @value } object, convert it to only its value
        if (value["@type"] && value["@type"].includes("@json") && value["@value"]) {
          value = value["@value"];
        }
        // Parse string values back to POJOs
        if (typeof value === "string") {
          try {
            processed[propId] = JSON.parse(value);
          }
          catch (e) {
            // Not valid JSON, leave as string
          }
        }
        else if (Array.isArray(value)) {
          // Handle array of JSON strings
          processed[propId] = value.map(v => {
            if (typeof v === "string") {
              try {
                return JSON.parse(v);
              }
              catch (e) {
                return v;
              }
            }
            return v;
          });
        }
      }
    }

    return processed;
  }

  /**
   * Remove all properties with keys beginning "//"
   * @param {object} resource
   * @return {object}
   * @private
   */
  _removeCommentProperties(resource) {
    for (const prop in resource) {
      if (prop.substring(0, 2) === "//") {
        delete resource[prop];
      }
    }
    return resource;
  }

  /**
   * Ensure that properties have proper @type and @container context entries
   * based on their ontology definitions.
   *
   * For ObjectProperty: adds @type: "@id"
   * For DatatypeProperty: adds @type with the XSD URI from rdfs:range
   * For array properties: adds @container: "@list" or "@set"
   *
   * @param {Object} propertyResource - The property resource to check
   * @param {Object} contextCollection - The Context collection to update
   */
  async ensurePropertyContext(propertyResource, contextCollection) {
    if (!propertyResource._id) {
      return;
    }

    try {
      // Lookup from Ontology if resource lacks rdfs:range or bold:container
      let propertyDef = propertyResource;
      if (!propertyResource["rdfs:range"] && !propertyResource["bold:container"]) {
        const ontologyDef = await this.collections.ontology.findOne({ _id: propertyResource._id });
        if (ontologyDef) {
          propertyDef = { ...propertyResource, ...ontologyDef };
        }
      }

      // Determine @type from property definition
      const contextType = await this._getPropertyContextType(propertyDef);

      // Determine @container from existing isArrayProperty logic
      const shouldBeArray = await this.isArrayProperty(propertyDef);
      const containerType = shouldBeArray ? (propertyDef["bold:container"] || "@list") : null;

      // Skip if nothing to add
      if (!contextType && !containerType) {
        return;
      }

      // Get current context document
      const existingContextDoc = await contextCollection.findOne({ _id: "@id" });
      if (!existingContextDoc) {
        return;
      }

      const currentPropertyContext = existingContextDoc[propertyResource._id];

      // Check if update needed
      const needsTypeUpdate = contextType && (!currentPropertyContext || currentPropertyContext["@type"] !== contextType);
      const needsContainerUpdate = containerType && (!currentPropertyContext || !currentPropertyContext["@container"]);

      if (!needsTypeUpdate && !needsContainerUpdate) {
        return;
      }

      // Build context update, preserving existing settings
      const contextUpdate = {
        [propertyResource._id]: {
          ...(currentPropertyContext && typeof currentPropertyContext === "object" ? currentPropertyContext : {}),
          ...(contextType ? { "@type": contextType } : {}),
          ...(containerType ? { "@container": containerType } : {})
        }
      };

      await contextCollection.updateOne(
        { _id: "@id" },
        { $set: contextUpdate },
        { upsert: true }
      );

      console.log(`Updated context for property ${propertyResource._id}: @type=${contextType}, @container=${containerType}`);
    }
    catch (error) {
      console.warn(`Failed to ensure property context for ${propertyResource._id}: ${error.message}`);
    }
  }

  "**** REASONER METHODS ****";

  /**
   * Bootstrap the reasoner with ontology data and capture inferences.
   *
   * The reasoner needs to be bootstrapped every time it starts,
   * so that it has inferred Facts in its triplestore for subsequent reasoning.
   *
   * However, the inferred Facts from the reasoner only need to be persisted to the collections once.
   * Use opts.persist the first time that reasoner is bootstrapped from a newly bootstrapped ontology.
   *
   *
   * @param {object} [opts] - Configuration options
   * @param {string} [opts.hylarUrl="http://localhost:4000"] - HyLAR server URL
   * @param {number} [opts.hylarPort=4000] - Port for HyLAR server if starting
   * @param {boolean} [opts.startHylar=false] - Start HyLAR child process
   * @param {boolean} [opts.classify=true] - Run classification after loading
   * @param {boolean} [opts.persist=true] - shorthand for opts.updateResources and opts.persistStatements
   * @param {boolean} [opts.updateResources=true] - Update resources with inferences
   * @param {boolean} [opts.persistStatements=true] - Persist statements to collection
   * @param {number} [opts.batchSize=1000] - Number of triples to insert per batch
   * @param {boolean} [opts.blankNodes=false] - include blank nodes
   * @param {boolean} [opts.debugDump=false] - write sparql and inferred props to files in /temp
   * @returns {Promise<object>} Result summary with counts
   */
  async bootstrapReasoner(opts = {}) {
    // Default options
    opts.hylarUrl = opts.hylarUrl || this.hylarUrl;
    opts.classify = opts.classify !== false;
    opts.persist = opts.persist !== false;
    opts.updateResources = opts.updateResources === false ? false : opts.persist;
    opts.persistStatements = opts.persistStatements === false ? false : opts.persist;
    opts.batchSize = opts.batchSize || 1000;

    console.log("🚀 Starting bootstrapReasoner...");
    const startTime = Date.now();

    // 1. Ensure HyLAR is running and healthy
    let hylarAvailable = false;
    if (opts.classify) {
      await this.checkHylar(opts);
      hylarAvailable = true;
    }

    // 2. Turn off classification for bulk loading (only if HyLAR available)
    if (hylarAvailable) {
      console.log("Turning off HyLAR classification...");
      try {
        const classifyOffResponse = await fetch(`${opts.hylarUrl}/classify/off`, {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        });

        if (!classifyOffResponse.ok) {
          throw new Error(`Failed to turn off classification: ${classifyOffResponse.statusText}`);
        }
      }
      catch (error) {
        throw new Error(`Failed to connect to HyLAR: ${error.message}`);
      }
    }

    // 3. Load all ontology resources
    console.log("Loading ontology resources...");
    const ontologyResources = await this.collections.ontology.find({}).toArray();
    console.log(`Found ${ontologyResources.length} ontology resources`);

    // 4. Convert to triples and insert into HyLAR (only if available)
    console.log("Converting resources to triples...");
    const triples = await this.getTriplesForResources(ontologyResources, {
      blankNodes: opts.blankNodes,
      includeStatements: false
    });
    console.log(`Generated ${triples.length} triples`);

    if (hylarAvailable) {
      if (opts.debugDump) fs.writeFileSync("/tmp/insert.sparql", "", { flag: "w" });
      // Insert triples in batches to avoid stack overflow in HyLAR
      const totalBatches = Math.ceil(triples.length / opts.batchSize);
      console.log(`Inserting ${triples.length} triples into HyLAR in ${totalBatches} batches of ${opts.batchSize}...`);
      for (let i = 0; i < triples.length; i += opts.batchSize) {
        const batch = triples.slice(i, i + opts.batchSize);
        const batchNum = Math.floor(i / opts.batchSize) + 1;
        console.log(`  Batch ${batchNum}/${totalBatches}: inserting ${batch.length} triples...`);

        const sparqlInsert = await this.createSparqlInsert(batch);
        if (opts.debugDump) fs.writeFileSync("/tmp/insert.sparql", sparqlInsert, { flag: "a" });
        try {
          const body = JSON.stringify({ query: sparqlInsert });
          const insertResponse = await fetch(`${opts.hylarUrl}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body
          });

          if (!insertResponse.ok) {
            throw new Error(`Failed to insert triples (batch ${batchNum}): ${insertResponse.statusText}`);
          }
        }
        catch (error) {
          console.log("HyLAR insert failed:", error);
          throw error;
        }
      }
      console.log(`Successfully inserted all ${triples.length} triples`);
    }

    let facts = [];
    let statements = [];
    let assembledResources = {};

    // 5. Turn on classification and get derivations (only if HyLAR available)
    if (opts.classify && hylarAvailable) {
      console.log("Turning on classification and reasoning...");
      const classifyOnResponse = await fetch(`${opts.hylarUrl}/classify/on`, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });

      if (!classifyOnResponse.ok) {
        throw new Error(`Failed to turn on classification: ${classifyOnResponse.statusText}`);
      }

      const classifyData = await classifyOnResponse.json();
      const derivations = classifyData.derivations;

      console.log(`Classification complete: ${derivations.additions.length} new derivations`);

      // 6. Convert derivations to Facts format
      facts = this._derivationsToFacts(derivations.additions, { blankNodes: opts.blankNodes });
      console.log(`Converted ${facts.length} facts from derivations`);

      // 7. Assemble facts into resources
      const context = await this.getContext();
      assembledResources = await this.assembleFactsIntoResources(facts, { context });
      console.log(`Assembled ${Object.keys(assembledResources).length} resources from facts`);
      if (opts.debugDump) fs.writeFileSync("/tmp/assembledResources.json", JSON.stringify(assembledResources,null,2));
      // 8. Create statements for inferred facts
      statements = await this.createStatementsForFacts(facts, {
        onlyInferred: true,
        metaPropsByPredicate: {
          "*": {
            "bold:when": new Date().toISOString(),
            "bold:createdBy": "bold:bootstrapReasoner",
            "bold:scope": "bold:system"
          }
        }
      });
      console.log(`Created ${statements.length} statements from facts`);

      // 9. Persist statements if collection available
      if (this.collections.statements && opts.persistStatements && statements.length > 0) {
        await this._persistStatements(statements);
        console.log(`Persisted ${statements.length} statements to collection`);
      }

      // 10. Merge assembled resources with existing ones
      if (opts.updateResources && Object.keys(assembledResources).length > 0) {
        const updateCount = await this._mergeAndUpdateResources(assembledResources, this.collections.ontology);
        console.log(`Updated ${updateCount} resources with inferred properties`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ bootstrapReasoner completed in ${Math.round(duration / 1000)} seconds`);

    return {
      duration,
      resourcesLoaded: ontologyResources.length,
      triplesGenerated: triples.length,
      factsInferred: facts.length,
      statementsCreated: statements.length,
      resourcesUpdated: Object.keys(assembledResources).length
    };
  }

  /**
   * Update a single resource with reasoning
   *
   * @param {string} resourceId - The _id of the resource to update
   * @param {object} update - Fields to update
   * @param {object} [opts] - Configuration options
   * @param {string} [opts.collection] collection name, otherwise getResourceForId will search for one.
   * @param {boolean} [opts.reasoning=true] - Enable reasoning for this update
   * @param {string} [opts.hylarUrl="http://localhost:4000"] - HyLAR server URL
   * @param {boolean} [opts.saveHylar=false] - save triples in HyLAR
   * @param {string} [opts.userId] - User ID for provenance
   * @param {boolean} [opts.includeStatements=false] - Include statements in response
   * @returns {Promise<object>} Update result with resource and metadata
   */
  async updateOne(resourceId, update, opts = {}) {
    check(resourceId, String);
    check(update, Object);
    check(opts, Match.Optional(Object));

    // Default options
    opts.reasoning = opts.reasoning !== false;
    opts.hylarUrl = opts.hylarUrl || this.hylarUrl;
    opts.saveHylar = opts.saveHylar === true;

    console.log(`Updating resource ${resourceId}...`);

    let collection;
    let resource;
    // 1. Load existing resource
    if (opts.collection) {
      collection = this.collections[opts.collection];
      if (collection) {
        resource = await collection.findOne({_id: resourceId});
      }
    }
    else {
      const foundIt = await this.getResourceForId(resourceId);
      if (foundIt) {
        collection = this.collections[foundIt.collection];
        resource = foundIt.resource;
      }
    }

    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    // 2. Merge update with existing resource
    const updatedResource = await this.mergeResources([resource, update], {
      mergeArrays: true
    });
    updatedResource._id = resourceId; // Ensure ID is preserved

    // 3. If reasoning enabled, send to HyLAR
    let inferredProperties = {};
    let statements = [];

    if (opts.reasoning) {
      await this.checkHylar(opts);
    }

    if (opts.reasoning) {
      console.log("Applying reasoning to update...");

      // Convert updated resource to triples
      const triples = await this.getTriplesForResources([updatedResource], {
        blankNodes: true,
        includeStatements: false
      });
      const sparqlInsert = await this.createSparqlInsert(triples);

      // Use the /update endpoint if available, otherwise use /query
      const updateUrl = `${opts.hylarUrl}/update`;
      const queryUrl = `${opts.hylarUrl}/query`;

      let response;
      try {
        // Try the /update endpoint first
        response = await fetch(updateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: sparqlInsert,
            save: opts.saveHylar
          })
        });
      }
      catch (error) {
        throw error;
        // // Fall back to /query endpoint
        // console.log("Falling back to /query endpoint");
        // response = await fetch(queryUrl, {
        //   method: "POST",
        //   headers: { "Content-Type": "application/json" },
        //   body: JSON.stringify({ query: sparqlInsert })
        // });
      }

      if (response.ok) {
        const responseData = await response.json();

        // Get derivations if available
        // it looks like /query and /update return different formats, fix this?
        const derivations = responseData.derivations ?? responseData;
        if (derivations.additions) {
          const facts = this._derivationsToFacts(derivations.additions);

          // Filter facts for this resource only
          const context = await this.getContext();
          const expandedResourceId = this.ld().expandQName(resourceId,context);
          const resourceFacts = facts.filter(f =>
            f.subject === expandedResourceId
          );

          if (resourceFacts.length > 0) {
            // Assemble facts into properties
            const context = await this.getContext();
            const assembled = await this.assembleFactsIntoResources(resourceFacts, { context });
            inferredProperties = assembled[resourceId] || {};

            // Create statements for inferred facts
            statements = await this.createStatementsForFacts(resourceFacts, {
              onlyInferred: true,
              metaPropsByPredicate: {
                "*": {
                  "bold:when": new Date().toISOString(),
                  "bold:updatedBy": opts.userId || "bold:system",
                  "bold:scope": "bold:resource"
                }
              }
            });

            // Persist statements if collection available
            if (this.collections.statements && statements.length > 0) {
              await this._persistStatements(statements);
              console.log(`Persisted ${statements.length} inferred statements`);
            }
          }
        }
      }
    }

    // 4. Merge inferred properties with update
    const finalResource = Object.keys(inferredProperties).length > 0
      ? await this.mergeResources([updatedResource, inferredProperties], { mergeArrays: true })
      : updatedResource;

    // 5. Update the resource in collection
    const updateResult = await collection.replaceOne(
      { _id: resourceId },
      finalResource,
      { upsert: false }
    );

    console.log(`✅ Resource ${resourceId} updated successfully`, finalResource);

    return {
      resource: finalResource,
      updateResult,
      inferredCount: statements.length,
      statements: opts.includeStatements ? statements : undefined
    };
  }

  /**
   * Ensure HyLAR is running and healthy.
   * If no hylarProcess exists, spawns one via _startHylarProcess().
   * Performs a health check with one retry (500ms delay) before throwing.
   *
   * @param {object} [opts] - Options
   * @param {string} [opts.hylarUrl] - HyLAR server URL (default: this.hylarUrl)
   * @param {number} [opts.hylarPort] - HyLAR server port (default: this.hylarPort)
   * @returns {Promise<void>} Resolves when HyLAR is confirmed healthy
   * @throws {Error} If HyLAR fails health check after retry
   */
  async checkHylar(opts = {}) {
    const hylarUrl = opts.hylarUrl || this.hylarUrl;
    const hylarPort = opts.hylarPort || this.hylarPort;

    // Spawn HyLAR if we haven't verified it yet
    if (!this.hylarProcess && !this._hylarVerified) {
      const proc = await this._startHylarProcess(hylarPort);
      if (proc) {
        this.hylarProcess = proc;
      }
      this._hylarVerified = true;
    }

    // Health check with one retry
    const doCheck = async () => {
      const response = await fetch(`${hylarUrl}/`, { method: "GET" });
      if (!response.ok) {
        throw new Error(`HyLAR health check returned ${response.status}`);
      }
    };

    try {
      await doCheck();
    }
    catch (error) {
      console.warn(`HyLAR health check failed (${error.message}), retrying in 500ms...`);
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        await doCheck();
      }
      catch (retryError) {
        this.hylarProcess = null;
        this._hylarVerified = false;
        throw new Error(`HyLAR not available at ${hylarUrl} after retry: ${retryError.message}`);
      }
    }
  }

  /**
   * Start HyLAR child process if not already running
   * @param {number} port - Port to start HyLAR on
   * @returns {Promise<ChildProcess|null>} The child process, or null if HyLAR was already running
   * @private
   */
  async _startHylarProcess(port = 4000) {
    // First check if HyLAR is already responding on this port
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) {
        console.log(`HyLAR is already running on port ${port}`);
        return null;
      }
    }
    catch (error) {
      // HyLAR not responding, proceed to start it
    }

    const hylarPath = path.join(process.cwd(), "modules/hylar-reasoner");

    console.log(`Starting HyLAR server on port ${port}...`);
    const hylarProcess = spawn("npm", ["run", `start-${port}`], {
      cwd: hylarPath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });

    // Watch for process exit/error and reset state so checkHylar() re-spawns
    hylarProcess.on("exit", (code, signal) => {
      console.warn(`HyLAR process exited (code: ${code}, signal: ${signal})`);
      this.hylarProcess = null;
      this._hylarVerified = false;
    });

    hylarProcess.on("error", (error) => {
      console.error(`HyLAR process error: ${error.message}`);
      this.hylarProcess = null;
      this._hylarVerified = false;
    });

    // Wait for server to be ready, or reject early if process dies
    await new Promise((resolve, reject) => {
      let settled = false;

      const onEarlyExit = (code, signal) => {
        if (!settled) {
          settled = true;
          reject(new Error(`HyLAR process exited before becoming ready (code: ${code}, signal: ${signal})`));
        }
      };
      hylarProcess.once("exit", onEarlyExit);

      const checkServer = async () => {
        if (settled) return;
        try {
          const response = await fetch(`http://localhost:${port}/`);
          if (response.ok) {
            settled = true;
            hylarProcess.removeListener("exit", onEarlyExit);
            console.log("HyLAR server is ready");
            resolve();
          }
          else {
            setTimeout(checkServer, 1000);
          }
        }
        catch (error) {
          setTimeout(checkServer, 1000);
        }
      };

      setTimeout(checkServer, 2000);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          hylarProcess.removeListener("exit", onEarlyExit);
          reject(new Error("HyLAR server failed to start within 30 seconds"));
        }
      }, 30000);
    });

    return hylarProcess;
  }

  /**
   * Convert HyLAR derivations to Facts format
   * @private
   */
  _derivationsToFacts(derivations, opts = {}) {
    if (!derivations || !Array.isArray(derivations)) {
      return [];
    }
    if (!opts.blankNodes) {
      derivations = derivations.filter((d) => {
        if (d.subject.indexOf("_:") === 0 || d.object.indexOf("_:") === 0) {
          return false;
        }
        return true;
      });
    }

    return derivations.map(d => ({
      subject: d.subject,
      predicate: d.predicate,
      object: d.object,
      explicit: d.explicit === true,
      rule: d.rule,
      causes: d.causes,
      asString: d.asString
    }));
  }

  /**
   * Persist statements to Statements collection
   * @private
   */
  async _persistStatements(statements) {
    if (!this.collections.statements || !statements || statements.length === 0) {
      return 0;
    }

    // Ensure each statement has an _id
    const statementsWithIds = statements.map(stmt => ({
      ...stmt,
      _id: stmt._id || `bold:statement-${Date.now()}-${Math.random().toString(36).substring(7)}`
    }));

    // Insert in batches
    const batchSize = 100;
    let insertedCount = 0;

    for (let i = 0; i < statementsWithIds.length; i += batchSize) {
      const batch = statementsWithIds.slice(i, Math.min(i + batchSize, statementsWithIds.length));
      const result = await this.collections.statements.insertMany(batch);
      insertedCount += result.insertedCount;
    }

    return insertedCount;
  }

  /**
   * Merge and update resources with inferred properties
   * @private
   */
  async _mergeAndUpdateResources(assembledResources, collection, opts = {}) {
    let updateCount = 0;
    // TODO impl this opt up the line
    const includeBlankNodes = opts.includeBlankNodes !== false;

    for (const [resourceId, assembledResource] of Object.entries(assembledResources)) {
      // Skip blank nodes
      if (!includeBlankNodes && resourceId.startsWith("_:")) {
        continue;
      }

      // Get existing resource
      const existing = await collection.findOne({ _id: resourceId });

      if (existing) {
        // Merge with existing
        const merged = await this.mergeResources([existing, assembledResource], {
          mergeArrays: true
        });

        // Update in collection
        await collection.replaceOne(
          { _id: resourceId },
          merged,
          { upsert: false }
        );
        updateCount++;
      }
      else {
        // Insert new resource
        const newResource = { ...assembledResource, _id: resourceId };
        await collection.insertOne(newResource);
        updateCount++;
      }
    }

    return updateCount;
  }

  /**
   * Insert the resources from the named collection into the reasoner triplestore,
   * then classify qnd capture the inferences as new properties and statements.
   * Usually, the inserted and inferred triples are not saved in HyLAR.
   *
   * @param {string} collectionName a named ontologize collection
   * @param {object} [opts] - Configuration options
   * @param {string} [opts.userId] - User ID for provenance
   * @param {string} [opts.hylarUrl="http://localhost:4000"] - HyLAR server URL
   * @param {number} [opts.hylarPort=4000] - Port for HyLAR server if starting
   * @param {boolean} [opts.persist=true] - shorthand for opts.updateResources and opts.persistStatements
   * @param {boolean} [opts.updateResources=true] - Update resources with inferences
   * @param {boolean} [opts.persistStatements=true] - Persist statements to collection
   * @param {boolean} [opts.saveHylar=false] - save triples in HyLAR
   * @param {number} [opts.batchSize=1000] - Number of triples to insert per batch
   * @param {boolean} [opts.blankNodes=false] - include blank nodes
   * @param {boolean} [opts.debugDump=false] - write sparql and inferred props to files in /temp
   * @returns {Promise<object>} Result summary with counts
   */
  async reasonCollection(collectionName, opts={}) {
    check(collectionName, String);

    // Validate collection exists
    const collection = this.collections[collectionName];
    if (!collection) {
      throw new Error(
        `Collection "${collectionName}" not found. ` +
        `Available collections: ${Object.keys(this.collections).join(", ")}`
      );
    }

    // Default options
    opts.hylarUrl = opts.hylarUrl || this.hylarUrl;
    opts.persist = opts.persist !== false;
    opts.updateResources = opts.updateResources === false ? false : opts.persist;
    opts.persistStatements = opts.persistStatements === false ? false : opts.persist;
    opts.saveHylar = opts.saveHylar === true; // default false for ABox
    opts.batchSize = opts.batchSize || 1000;
    opts.blankNodes = opts.blankNodes || false;
    opts.debugDump = opts.debugDump || false;

    console.log(`Starting reasonCollection for "${collectionName}"...`);
    const startTime = Date.now();

    // 1. Ensure HyLAR is running and healthy
    await this.checkHylar(opts);

    // 3. Load all resources from the named collection
    console.log(`Loading resources from "${collectionName}" collection...`);
    const resources = await collection.find({}).toArray();
    console.log(`Found ${resources.length} resources`);

    if (resources.length === 0) {
      const duration = Date.now() - startTime;
      return {
        duration,
        collectionName,
        resourcesLoaded: 0,
        triplesGenerated: 0,
        factsInferred: 0,
        statementsCreated: 0,
        resourcesUpdated: 0
      };
    }

    // 4. Convert resources to triples
    console.log("Converting resources to triples...");
    const triples = await this.getTriplesForResources(resources, {
      blankNodes: opts.blankNodes,
      includeStatements: false
    });
    console.log(`Generated ${triples.length} triples`);

    // 5. Group triples by subject so batches contain complete resources
    const triplesBySubject = new Map();
    for (const triple of triples) {
      if (!triplesBySubject.has(triple.s)) {
        triplesBySubject.set(triple.s, []);
      }
      triplesBySubject.get(triple.s).push(triple);
    }

    // Build batches: add complete resources until batch exceeds batchSize
    const batches = [];
    let currentBatch = [];
    for (const [, resourceTriples] of triplesBySubject) {
      if (currentBatch.length > 0 && currentBatch.length + resourceTriples.length > opts.batchSize) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      currentBatch.push(...resourceTriples);
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    // 6. Send each batch to /update, accumulating derivations
    const allAdditions = [];
    console.log(`Inserting ${triples.length} triples via /update in ${batches.length} batches (batchSize ${opts.batchSize})...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`  Batch ${i + 1}/${batches.length}: inserting ${batch.length} triples...`);

      const sparqlInsert = await this.createSparqlInsert(batch);
      if (opts.debugDump) fs.writeFileSync("/tmp/reasonCollection-insert.sparql", sparqlInsert, { flag: "a" });

      try {
        const response = await fetch(`${opts.hylarUrl}/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: sparqlInsert,
            save: opts.saveHylar
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to insert triples (batch ${i + 1}): ${response.statusText}`);
        }

        const responseData = await response.json();
        // /update may return { derivations: { additions } } or { additions } directly
        const derivations = responseData.derivations ?? responseData;
        if (derivations.additions && derivations.additions.length > 0) {
          allAdditions.push(...derivations.additions);
          console.log(`  Batch ${i + 1}: ${derivations.additions.length} new derivations`);
        }
      }
      catch (error) {
        console.error(`HyLAR /update failed on batch ${i + 1}:`, error);
        throw error;
      }
    }
    console.log(`Successfully processed all ${triples.length} triples, total derivations: ${allAdditions.length}`);

    // 8. Process derivations
    let facts = [];
    let statements = [];
    let assembledResources = {};

    if (allAdditions.length > 0) {
      // Convert derivations to Facts
      facts = this._derivationsToFacts(allAdditions, { blankNodes: opts.blankNodes });
      console.log(`Converted ${facts.length} facts from derivations`);

      // Assemble facts into resources
      const context = await this.getContext();
      assembledResources = await this.assembleFactsIntoResources(facts, { context });
      console.log(`Assembled ${Object.keys(assembledResources).length} resources from facts`);
      if (opts.debugDump) fs.writeFileSync("/tmp/reasonCollection-assembled.json", JSON.stringify(assembledResources, null, 2));

      // Create statements for inferred facts
      const metaProps = {
        "bold:when": new Date().toISOString(),
        "bold:createdBy": "bold:reasonCollection",
        "bold:scope": "bold:system"
      };
      if (opts.userId) {
        metaProps["bold:updatedBy"] = opts.userId;
      }

      statements = await this.createStatementsForFacts(facts, {
        onlyInferred: true,
        metaPropsByPredicate: {
          "*": metaProps
        }
      });
      console.log(`Created ${statements.length} statements from facts`);

      // 9. Persist statements
      if (this.collections.statements && opts.persistStatements && statements.length > 0) {
        await this._persistStatements(statements);
        console.log(`Persisted ${statements.length} statements to collection`);
      }

      // 10. Merge inferred properties back into the source collection
      if (opts.updateResources && Object.keys(assembledResources).length > 0) {
        const updateCount = await this._mergeAndUpdateResources(assembledResources, collection);
        console.log(`Updated ${updateCount} resources with inferred properties`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`reasonCollection "${collectionName}" completed in ${Math.round(duration / 1000)} seconds`);

    return {
      duration,
      collectionName,
      resourcesLoaded: resources.length,
      triplesGenerated: triples.length,
      factsInferred: facts.length,
      statementsCreated: statements.length,
      resourcesUpdated: Object.keys(assembledResources).length
    };
  }

}

// Constants
OntologizeServer.TYPE_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// Export the extended class as default
export default OntologizeServer;
