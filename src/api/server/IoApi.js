/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { readFile, writeFile } from "fs/promises";
import { check, Match } from "../../lib/check.js";
import _ from "lodash";
import path from "path";
import { ApiNamespace } from "../ApiNamespace.js";

/**
 * `ontologizeServer.io` — JSON-LD import and export: bootstrap from files,
 * normalize + persist resources into the right collections, and export a
 * collection back to well-formed JSON-LD. Uses the shared JsonPropertyStore
 * (this.ontologize._jsonProps) and core collection-routing predicates.
 */
export class IoApi extends ApiNamespace {
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
    const files = opts.bootstrapFiles || this.ontologize.bootstrapFiles;
    const basePath = opts.basePath || this.ontologize.bootstrapPath;
    let removeCollections;
    if (Array.isArray(opts.removeCollections)) {
      removeCollections = opts.removeCollections;
    }
    else if (opts.removeAll !== false) {
      removeCollections = Object.keys(this.collections);
    }

    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("No bootstrap files configured. Pass opts.bootstrapFiles to constructor or opts.files to bootstrap()");
    }

    if (removeCollections) {
      console.log("======== BOOTSTRAP REMOVE ALL ========");
      // from all known collections
      for await (const colName of removeCollections) {
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
          if (this.ontologize._isOntologyResource(resource)) {
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
        statementIdsRewritten: 0,
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
                // Source-supplied ids replaced by content hashes. Counted rather
                // than logged per resource — one import can carry thousands.
                if (processed.statementIdRewritten) {
                  stats.statementIdsRewritten++;
                }
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
      const contextForOutput = { ...(await this.ontologize.getContext(context)) };
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
    processed = await this.ontologize._jsonProps._stringifyJsonProperties(processed);

    // Step 4: Apply normalization if requested
    if (normalize) {
      try {
        const contextForCompaction = await this.ontologize.getContext(context);
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

    // Get existing context from the Context collection, or start with the class default
    let existingContext = this.ontologize.constructor.DEFAULT_CONTEXT;
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
      processedResource = await this.ontologize._jsonProps._stringifyJsonProperties(processedResource, {useCache: false});

      processedResource = this._removeCommentProperties(processedResource);

      // Step 1-b: expand resource with its own context
      if (incomingContext) {
        processedResource = await ld.expand(processedResource, incomingContext);
      }

      // Get context for compaction (provided, from Context collection, or default)
      const contextForCompaction = await this.ontologize.getContext();
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
      processedResource = await this.ontologize._jsonProps._parseJsonProperties(processedResource);
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
      isTBoxResource = await this.ontologize.isTBoxResource(processedResource);
    }

    // Step 5.5: Detect Statement resources
    isStatementResource = this.ontologize.isStatementResource(processedResource);

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
    if (ensureArrayProps && this.ontologize._isPropertyResource(processedResource)) {
      await this.ensurePropertyContext(processedResource, contextCollection);
    }

    // Step 5.75: Add dcterms:isPartOf for non-ontology resources
    // This indicates which owl:Ontology resources the resource is part of
    if (addIsPartOf && leadingOntologyIds.length > 0 && !this.ontologize._isOntologyResource(processedResource)) {
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

    // Step 5.9: Give an imported Statement a deterministic, content-addressed
    // _id, the same scheme reasoning uses (statement-idempotency-spec.md §1).
    //
    // Source files name their statements however they like — nice.all.full.jsonld
    // calls one `nice:K0865-K0377`, built from the subject and object of the
    // triple it reifies. Those ids are only *incidentally* stable: change the
    // naming convention, or import the same assertion from a second source, and
    // the same statement lands twice. Hashing (s, p, o, provenance) makes a
    // re-import address the same document, which is what lets the statements
    // collection be rebuilt from scratch and re-imported without accumulating.
    //
    // Deliberately last: the hash covers dcterms:isPartOf, which Step 5.75 assigns
    // from the leading ontology, and beforeSaveFn (Step 5.8) may still have
    // rewritten the triple. Running after both means the id describes what is
    // actually persisted — and beforeSaveFn still sees the source's own id, which
    // callers filter on.
    let statementIdRewritten = false;
    if (isStatementResource) {
      const statementId = this.ontologize.rdf._statementIdForResource(processedResource);
      if (!statementId) {
        // Typed rdf:Statement but no complete triple to hash — nothing to be
        // content-addressed by, so keep whatever id the source supplied.
        console.warn(`Statement ${processedResource._id} has no complete rdf:subject/predicate/object; keeping source _id`);
      }
      else if (statementId !== processedResource._id) {
        processedResource._id = statementId;
        statementIdRewritten = true;
      }
    }

    // Step 6: Save to appropriate collection(s)

    // if this is destined for an ABox collection,
    if (!isTBoxResource || shareTBox) {
      // Use aboxOnly — Statement/TBox routing is handled in the save logic below
      const resolved = await this.ontologize.getCollectionForResource(processedResource, { useNamespaceCollections, aboxOnly: true });
      if (resolved) {
        collection = resolved.collection;
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
      statementIdRewritten,
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

    if (await this.ontologize._jsonProps._isJsonProperty(resource)) {
      return "@json";
    }

    // Default for ObjectProperty-like behavior (range points to a class)
    if (resource["rdfs:range"] && !resource["rdfs:range"].startsWith("xsd:")) {
      return "@id";
    }

    return null; // No type determination possible
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
      const shouldBeArray = await this.ontologize.schema.isArrayProperty(propertyDef);
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

}

export default IoApi;
