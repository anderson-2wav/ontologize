/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { spawn } from "child_process";
import path from "path";
import * as fs from "node:fs";
import { check } from "../../lib/check.js";
import { ApiNamespace } from "../ApiNamespace.js";

/**
 * `ontologizeServer.reasoner` — HyLAR reasoning integration: manage the HyLAR
 * process (checkHylar / _startHylarProcess), bootstrap and warm the triplestore,
 * reason over a collection, and persist inferred properties + statements. HyLAR
 * process state lives on the owning instance (this.ontologize.hylarProcess,
 * ._hylarVerified, ._hylarInitialized, ...). Uses the rdf namespace for SPARQL /
 * fact assembly and the io / archive namespaces for a clean reload.
 */
export class ReasonerApi extends ApiNamespace {
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
    opts.hylarUrl = opts.hylarUrl || this.ontologize.hylarUrl;
    opts.classify = opts.classify !== false;
    opts.persist = opts.persist !== false;
    opts.updateResources = opts.updateResources === false ? false : opts.persist;
    opts.persistStatements = opts.persistStatements === false ? false : opts.persist;
    opts.batchSize = opts.batchSize || 1000;

    console.log("🚀 Starting bootstrapReasoner...");
    const startTime = Date.now();

    // 1. Restore a clean, unreasoned ontology collection
    const archive = opts.ontologyArchive || this.ontologize.ontologyArchive;
    if (archive) {
      console.log(`Restoring clean ontology from archive: ${archive}`);
      await this.ontologize.archive.restoreFromArchive({ archive });
    }
    else {
      console.warn("No restore archive configured — falling back to bootstrap() for clean ontology");
      await this.ontologize.io.bootstrap({ removeCollections: ["ontology"] });
    }

    // 2. Ensure HyLAR is running and healthy
    let hylarAvailable = false;
    if (opts.classify) {
      await this.checkHylar(opts);
      hylarAvailable = true;
    }

    // 3. Turn off classification for bulk loading (only if HyLAR available)
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

    // 4. Load all ontology resources (collection is clean — no reasoned resources to skip)
    console.log("Loading ontology resources...");
    const ontologyResources = await this.collections.ontology.find({}).toArray();
    console.log(`Found ${ontologyResources.length} ontology resources to reason`);

    // 5. Convert to triples and insert into HyLAR (only if available)
    console.log("Converting resources to triples...");
    const triples = await this.ontologize.rdf.getTriplesForResources(ontologyResources, {
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

        const sparqlInsert = await this.ontologize.rdf.createSparqlInsert(batch);
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

    // 6. Turn on classification and get derivations (only if HyLAR available)
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

      // 7. Convert derivations to Facts format
      facts = this.ontologize.rdf._derivationsToFacts(derivations.additions, { blankNodes: opts.blankNodes });
      console.log(`Converted ${facts.length} facts from derivations`);

      // 8. Assemble facts into resources
      const context = await this.ontologize.getContext();
      assembledResources = await this.ontologize.rdf.assembleFactsIntoResources(facts, { context });
      console.log(`Assembled ${Object.keys(assembledResources).length} resources from facts`);
      if (opts.debugDump) fs.writeFileSync("/tmp/assembledResources.json", JSON.stringify(assembledResources,null,2));
      // 9. Create statements for inferred facts
      statements = await this.ontologize.rdf.createStatementsForFacts(facts, {
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

      // 10. Remove previous bootstrapReasoner statements and persist new ones
      if (this.collections.statements && opts.persistStatements && statements.length > 0) {
        const deleteResult = await this.collections.statements.deleteMany({ "bold:createdBy": "bold:bootstrapReasoner" });
        console.log(`Removed ${deleteResult.deletedCount} previous bootstrapReasoner statements`);
        await this._persistStatements(statements);
        console.log(`Persisted ${statements.length} new statements to collection`);
      }

      // 11. Merge assembled resources with existing ones
      if (opts.updateResources && Object.keys(assembledResources).length > 0) {
        const updated = await this._mergeAndUpdateResources(assembledResources, this.collections.ontology);
        console.log(`Updated ${updated.length} resources with inferred properties`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ bootstrapReasoner completed in ${Math.round(duration / 1000)} seconds`);

    // Mark reasoner as initialized whether called directly or via ensureReasoner
    this.ontologize._hylarInitialized = true;
    this.ontologize._hylarCrashCount = 0;

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
   * Ensure HyLAR is running and healthy.
   * If no hylarProcess exists, spawns one via _startHylarProcess().
   * Performs a health check with one retry (500ms delay) before throwing.
   *
   * @param {object} [opts] - Options
   * @param {string} [opts.hylarUrl] - HyLAR server URL (default: this.ontologize.hylarUrl)
   * @param {number} [opts.hylarPort] - HyLAR server port (default: this.ontologize.hylarPort)
   * @returns {Promise<void>} Resolves when HyLAR is confirmed healthy
   * @throws {Error} If HyLAR fails health check after retry
   */
  async checkHylar(opts = {}) {
    const hylarUrl = opts.hylarUrl || this.ontologize.hylarUrl;
    const hylarPort = opts.hylarPort || this.ontologize.hylarPort;

    // Spawn HyLAR if we haven't verified it yet
    if (!this.ontologize.hylarProcess && !this.ontologize._hylarVerified) {
      const proc = await this._startHylarProcess(hylarPort);
      if (proc) {
        this.ontologize.hylarProcess = proc;
      }
      this.ontologize._hylarVerified = true;
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
        this.ontologize.hylarProcess = null;
        this.ontologize._hylarVerified = false;
        throw new Error(`HyLAR not available at ${hylarUrl} after retry: ${retryError.message}`);
      }
    }
  }

  /**
   * Warm the reasoner: load THIS instance's live ontology collection into HyLAR
   * and classify, so the in-memory store holds the current closure and subsequent
   * updateOne() calls reason incrementally and correctly.
   *
   * Unlike bootstrapReasoner, warmReasoner:
   *   - never restores an archive (so it can never `mongorestore --drop` and clobber
   *     shared collections), and
   *   - never persists — it writes nothing back to Mongo (no resource updates, no
   *     Statements). It only primes HyLAR's in-memory store.
   *
   * The ontology collection already contains its materialized inferences; loading
   * that already-reasoned state and re-classifying is idempotent (it re-derives no
   * substantive new facts — see ontologize-tour-spec.md "Empirical finding: double-
   * reasoning is idempotent"), so warming from live materialized facts is safe.
   *
   * This is the method ensureReasoner() calls. For discovering and *persisting*
   * inferences (initial classify / deliberate re-classify) see bootstrapReasoner.
   *
   * @param {object} [opts] - Configuration options
   * @param {string} [opts.hylarUrl] - HyLAR server URL
   * @param {number} [opts.hylarPort] - Port for HyLAR server if starting
   * @param {boolean} [opts.classify=true] - Load into HyLAR and classify (needs HyLAR)
   * @param {number} [opts.batchSize=1000] - Triples to insert per batch
   * @param {boolean} [opts.blankNodes=false] - include blank nodes
   * @returns {Promise<object>} { duration, resourcesLoaded, triplesGenerated }
   */
  async warmReasoner(opts = {}) {
    opts.hylarUrl = opts.hylarUrl || this.ontologize.hylarUrl;
    opts.classify = opts.classify !== false;
    opts.batchSize = opts.batchSize || 1000;

    console.log("🔥 Warming reasoner from live ontology...");
    const startTime = Date.now();

    // 1. Ensure HyLAR is running and healthy (only if we intend to classify)
    let hylarAvailable = false;
    if (opts.classify) {
      await this.checkHylar(opts);
      hylarAvailable = true;
    }

    // 2. Turn off classification for bulk loading
    if (hylarAvailable) {
      const classifyOffResponse = await fetch(`${opts.hylarUrl}/classify/off`, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      if (!classifyOffResponse.ok) {
        throw new Error(`Failed to turn off classification: ${classifyOffResponse.statusText}`);
      }
    }

    // 3. Load the live ontology resources (materialized closure included) and
    //    convert to triples. These docs are fetched fresh and discarded, so it is
    //    safe that getTriplesForResources mutates them.
    const ontologyResources = await this.collections.ontology.find({}).toArray();
    const triples = await this.ontologize.rdf.getTriplesForResources(ontologyResources, {
      blankNodes: opts.blankNodes,
      includeStatements: false
    });
    console.log(`Warming HyLAR with ${ontologyResources.length} resources / ${triples.length} triples`);

    // 4. Bulk insert into HyLAR, then classify on to establish the closure and
    //    leave the store classified for subsequent incremental /update calls.
    if (hylarAvailable) {
      for (let i = 0; i < triples.length; i += opts.batchSize) {
        const batch = triples.slice(i, i + opts.batchSize);
        const sparqlInsert = await this.ontologize.rdf.createSparqlInsert(batch);
        const insertResponse = await fetch(`${opts.hylarUrl}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: sparqlInsert })
        });
        if (!insertResponse.ok) {
          throw new Error(`Failed to insert triples while warming: ${insertResponse.statusText}`);
        }
      }

      const classifyOnResponse = await fetch(`${opts.hylarUrl}/classify/on`, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      if (!classifyOnResponse.ok) {
        throw new Error(`Failed to turn on classification: ${classifyOnResponse.statusText}`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ warmReasoner completed in ${Math.round(duration / 1000)} seconds`);

    this.ontologize._hylarInitialized = true;
    this.ontologize._hylarCrashCount = 0;

    return {
      duration,
      resourcesLoaded: ontologyResources.length,
      triplesGenerated: triples.length
    };
  }

  /**
   * Ensure HyLAR is running, healthy, and warmed with the current ontology closure.
   * Uses a promise lock so concurrent callers await the same warm-up.
   */
  async ensureReasoner(opts = {}) {
    await this.checkHylar(opts);
    if (!this.ontologize._hylarInitialized) {
      if (!this.ontologize._initializingPromise) {
        console.warn("ensureReasoner initializing");
        this.ontologize._initializingPromise = this.warmReasoner(opts)
          .then((result) => {
            this.ontologize._hylarInitialized = true;
            this.ontologize._hylarCrashCount = 0;
            this.ontologize._bootstrapResult = result;
            console.warn("======= reasoner initialized. ======");
            return result;
          })
          .finally(() => { this.ontologize._initializingPromise = null; });
      }
      else {
        console.warn("continue waiting on ensureReasoner initializing");
      }
      return await this.ontologize._initializingPromise;
    }
    return {};
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

    const hylarPath = path.join(process.env.APP_DIR, "modules/hylar-reasoner");

    const heapSize = Meteor.settings.hylarHeapSize ?? 8192;
    // Set hylarNative: false in settings to force the JS reasoner (disables the
    // Rust native insertion phase). Used to A/B against the native path when
    // investigating regressions. Defaults to native (env var unset).
    const useNative = Meteor.settings.hylarNative ?? true;
    console.log(`Starting HyLAR server on port ${port} with heap size ${heapSize}${useNative ? "" : " (native disabled, JS fallback)"}`);
    const serverScript = path.join(hylarPath, "hylar/server/server.js");
    const childEnv = { ...process.env, NODE_OPTIONS: `--max-old-space-size=${heapSize}` };
    if (!useNative) {
      childEnv.HYLAR_NATIVE = "0";
    }
    const hylarProcess = spawn(process.execPath, [serverScript, "--port", String(port)], {
      cwd: hylarPath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: childEnv
    });

    hylarProcess.stdout.on("data", (data) => {
      console.log(`[HyLAR] ${data.toString().trimEnd()}`);
    });

    hylarProcess.stderr.on("data", (data) => {
      console.warn(`[HyLAR] ${data.toString().trimEnd()}`);
    });

    // Watch for process exit/error and reset state so checkHylar() re-spawns
    hylarProcess.on("exit", (code, signal) => {
      console.warn(`HyLAR process exited (code: ${code}, signal: ${signal})`);
      this.ontologize.hylarProcess = null;
      this.ontologize._hylarVerified = false;
      this.ontologize._hylarInitialized = false;
      this.ontologize._initializingPromise = null;
      this.ontologize._hylarCrashCount = (this.ontologize._hylarCrashCount || 0) + 1;
      if (this.ontologize._hylarCrashCount <= 3) {
        this.ensureReasoner().catch(err => {
          console.error("HyLAR auto-recovery failed:", err.message);
        });
      }
      else {
        console.error("HyLAR crashed too many times, not restarting.");
      }
    });

    hylarProcess.on("error", (error) => {
      console.error(`HyLAR process error: ${error.message}`);
      this.ontologize.hylarProcess = null;
      this.ontologize._hylarVerified = false;
      this.ontologize._hylarInitialized = false;
      this.ontologize._initializingPromise = null;
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
   * Merge and update resources with inferred properties.
   * When singleCollection is false (default), resolves each resource's target collection
   * via getCollectionForResource, so inferences on resources from different collections
   * are routed correctly.
   * @param {object} assembledResources - keyed by resource _id
   * @param {object} collection - fallback collection
   * @param {object} [opts]
   * @param {boolean} [opts.includeBlankNodes=true]
   * @param {boolean} [opts.singleCollection=false] - if true, skip per-resource resolution
   * @param {boolean} [opts.updateOnly=false] - merge into existing resources only; never insert new ones
   * @returns {Promise<string[]>} ids of the resources actually written (merged/inserted)
   * @private
   */
  async _mergeAndUpdateResources(assembledResources, collection, opts = {}) {
    const written = [];
    // TODO impl this opt up the line
    const includeBlankNodes = opts.includeBlankNodes !== false;

    for (const [resourceId, assembledResource] of Object.entries(assembledResources)) {
      // Skip blank nodes
      if (!includeBlankNodes && resourceId.startsWith("_:")) {
        continue;
      }

      // Resolve target collection per resource, falling back to the passed-in collection
      let targetCollection = collection;
      if (!opts.singleCollection) {
        const resolved = await this.ontologize.getCollectionForResource(
          { _id: resourceId, ...assembledResource }
        );
        if (resolved) {
          targetCollection = resolved.collection;
        }
      }

      // Get existing resource
      const existing = await targetCollection.findOne({ _id: resourceId });

      if (existing) {
        // Merge with existing
        const merged = await this.ontologize.mergeResources([existing, assembledResource], {
          mergeArrays: true
        });
        merged["bold:reasoned"] = new Date().toISOString();

        // Update in collection
        await targetCollection.replaceOne(
          { _id: resourceId },
          merged,
          { upsert: false }
        );
        written.push(resourceId);
      }
      else {
        // updateOnly: don't create new documents for inferred-but-unknown subjects
        // (e.g. owl:Nothing / ontology-level URIs that shouldn't become resources).
        if (opts.updateOnly) {
          continue;
        }
        // Insert new resource
        const newResource = { ...assembledResource, _id: resourceId, "bold:reasoned": new Date().toISOString() };
        await targetCollection.insertOne(newResource);
        written.push(resourceId);
      }
    }

    return written;
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
   * @param {boolean} [opts.onlyUnReasoned=true] - only reason resources without bold:reasoned
   * @param {number} [opts.batchSize=1000] - Number of triples to insert per batch
   * @param {boolean} [opts.blankNodes=false] - include blank nodes
   * @param {number} [opts.retries=5] - if hylar call fails, try again [5] times
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
    opts.hylarUrl = opts.hylarUrl || this.ontologize.hylarUrl;
    opts.persist = opts.persist !== false;
    opts.updateResources = opts.updateResources === false ? false : opts.persist;
    opts.persistStatements = opts.persistStatements === false ? false : opts.persist;
    opts.saveHylar = opts.saveHylar === true; // default false for ABox
    opts.batchSize = opts.batchSize || 1000;
    opts.blankNodes = opts.blankNodes || false;
    opts.debugDump = opts.debugDump || false;
    opts.onlyUnReasoned = opts.onlyUnReasoned !== false;
    opts.retries = typeof opts.retries === "number" ? opts.retries : 5;

    console.log(`Starting reasonCollection for "${collectionName}"...`);
    const startTime = Date.now();

    // 1. Ensure HyLAR is running, healthy, and bootstrapped
    await this.ensureReasoner(opts);

    // 3. Load unreasoned resources (skip bold:reasoned to prevent double-reasoning)
    console.log(`Loading resources from "${collectionName}" collection...`);
    const allCount = await collection.countDocuments({});
    const selector = opts.onlyUnReasoned ? { "bold:reasoned": { $exists: false } } : {};
    const resources = await collection.find(selector).toArray();
    if (resources.length < allCount) {
      console.log(`Skipping ${allCount - resources.length} already-reasoned resources`);
    }
    console.log(`Found ${resources.length} resources to reason`);

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
    const triples = await this.ontologize.rdf.getTriplesForResources(resources, {
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

    // 6. Process each batch: send to /update, then persist derivations immediately
    //    Combined with bold:reasoned, this allows resuming after a crash.
    let totalFacts = 0;
    let totalStatements = 0;
    let totalUpdated = 0;
    console.log(`Inserting ${triples.length} triples via /update in ${batches.length} batches (batchSize ${opts.batchSize})...`);

    // Hoist context and metaProps — they don't change per batch
    const context = await this.ontologize.getContext();
    const metaProps = {
      "bold:when": new Date().toISOString(),
      "bold:createdBy": "bold:reasonCollection",
      "bold:scope": "bold:system"
    };
    if (opts.userId) {
      metaProps["bold:updatedBy"] = opts.userId;
    }
    let retries = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`  Batch ${i + 1}/${batches.length}: inserting ${batch.length} triples...`);

      const sparqlInsert = await this.ontologize.rdf.createSparqlInsert(batch);
      if (opts.debugDump) fs.writeFileSync("/tmp/reasonCollection-insert.sparql", sparqlInsert, { flag: "a" });

      let additions = [];
      const maxRetries = opts.retries || 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await this.ensureReasoner(opts);
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
            additions = derivations.additions;
            console.log(`  Batch ${i + 1}: ${additions.length} new derivations`);
          }
          break;
        }
        catch (error) {
          if (attempt < maxRetries) {
            console.warn(`HyLAR /update failed on batch ${i + 1} (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`, error.message);
          }
          else {
            console.error(`HyLAR /update failed on batch ${i + 1} after ${attempt + 1} attempts:`, error);
            throw error;
          }
        }
      }

      // Process and persist this batch's derivations immediately
      if (additions.length > 0) {
        const facts = this.ontologize.rdf._derivationsToFacts(additions, { blankNodes: opts.blankNodes });
        totalFacts += facts.length;

        const assembledResources = await this.ontologize.rdf.assembleFactsIntoResources(facts, { context });
        if (opts.debugDump) fs.writeFileSync("/tmp/reasonCollection-assembled.json", JSON.stringify(assembledResources, null, 2), { flag: "a" });

        const statements = await this.ontologize.rdf.createStatementsForFacts(facts, {
          onlyInferred: true,
          metaPropsByPredicate: { "*": metaProps }
        });
        totalStatements += statements.length;

        if (this.collections.statements && opts.persistStatements && statements.length > 0) {
          await this._persistStatements(statements);
        }

        if (opts.updateResources && Object.keys(assembledResources).length > 0) {
          const updated = await this._mergeAndUpdateResources(assembledResources, collection);
          totalUpdated += updated.length;
        }

        console.log(`  Batch ${i + 1}: persisted ${facts.length} facts, ${statements.length} statements, ${Object.keys(assembledResources).length} resources`);
      }
    }
    console.log(`Successfully processed all ${triples.length} triples: ${totalFacts} facts, ${totalStatements} statements, ${totalUpdated} resources updated`);

    const duration = Date.now() - startTime;
    console.log(`reasonCollection "${collectionName}" completed in ${Math.round(duration / 1000)} seconds`);

    return {
      duration,
      collectionName,
      resourcesLoaded: resources.length,
      triplesGenerated: triples.length,
      factsInferred: totalFacts,
      statementsCreated: totalStatements,
      resourcesUpdated: totalUpdated
    };
  }
}

export default ReasonerApi;
