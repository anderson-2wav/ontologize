/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check, Match } from "./lib/check.js";
import { Ontologize } from "./Ontologize.js";
import _ from "lodash";
import path from "path";
import { ArchiveApi } from "./api/server/ArchiveApi.js";
import { RdfApi } from "./api/server/RdfApi.js";
import { IoApi } from "./api/server/IoApi.js";
import { ReasonerApi } from "./api/server/ReasonerApi.js";
import { JsonPropertyStore } from "./api/server/JsonPropertyStore.js";
import { SERVER_FLAT_API, installFlatApi } from "./api/flatApi.js";

/**
 * Server-only extension of the Ontologize class
 * These methods require Node.js environment and should not be used in browser contexts
 */
export class OntologizeServer extends Ontologize {
  // Singleton instance (separate from parent Ontologize._instance)
  static _instance = null;

  /**
   * How many resources a long loop processes before handing the event loop back,
   * and how many are expanded per ld.expand() call.
   *
   * ld.expand does not yield internally, so a single call over a 1,000-resource
   * batch blocks the process for its whole duration. Measured on the track
   * collection: one call = 226 ms with the event loop never running; chunked by
   * 250 = 46 ms worst block; by 100 = 22 ms, at the same total cost (chunking is
   * marginally faster, so there is nothing to trade off).
   */
  static YIELD_EVERY = 100;

  /**
   * BUI JSON type URIs that require special serialization handling.
   * Properties with these ranges store POJOs in MongoDB but serialize as JSON strings.
   * Consumed by the shared JsonPropertyStore (this._jsonProps).
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
   * Hand control back to the event loop so queued I/O can run.
   *
   * `setImmediate`, deliberately, NOT `process.nextTick`: nextTick callbacks are
   * drained before the event loop continues, so a nextTick "yield" inside a hot
   * loop still starves every socket and timer. setImmediate schedules on the
   * check phase, after pending I/O callbacks have had their turn.
   *
   * Held on the core instance rather than a namespace: it is shared plumbing that
   * any long-running server loop may need, reached as `this.ontologize._yieldToEventLoop()`.
   *
   * @returns {Promise<void>}
   * @private
   */
  _yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
  }

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
   * @param {object} [opts] - Configuration options (also all opts from Ontologize)
   * @param {string[]} [opts.bootstrapFiles] - Array of file paths for bootstrap ontologies
   * @param {string} [opts.bootstrapPath] - Base path for relative bootstrap file paths
   * @param {string} [opts.ontologyArchive="ontology.archive"] - mongodb archive filename for ontology
   * @param {string} [opts.archivePath] - Base path for relative archive filenames (defaults to ./bold-assets/archives)
   * @param {string} [opts.mongoUrl] - MongoDB connection URL for mongorestore (defaults to MONGO_URL env var)
   */
  constructor(ontologyCollection, contextCollection, statementsCollection, opts = {}) {
    super(ontologyCollection, contextCollection, statementsCollection, opts);
    this.bootstrapFiles = opts.bootstrapFiles || [];
    this.bootstrapPath = opts.bootstrapPath || path.join((process.env.APP_DIR || process.cwd()),"./bold-assets/bootstrap");
    this.opts = opts;

    // Archive restore config for bootstrapReasoner
    this.ontologyArchive = opts.ontologyArchive || "ontology.archive";
    this.archivePath = opts.archivePath || path.join((process.env.APP_DIR || process.cwd()), "./bold-assets/archives");
    this.mongoUrl = opts.mongoUrl || process.env.MONGO_URL || "mongodb://127.0.0.1:3201/meteor";

    // HyLAR process management defaults
    this.hylarUrl = opts.hylarUrl || "http://localhost:4000";
    this.hylarPort = opts.hylarPort || 4000;
    this.hylarProcess = null;
    this._hylarVerified = false;
    this._hylarInitialized = false;
    this._initializingPromise = null;
    this._hylarCrashCount = 0;

    // Shared JSON-property helper store, used by the io and rdf namespaces.
    this._jsonProps = new JsonPropertyStore(this);
  }

  // ==========================================================================
  // Server API namespaces (io, archive, rdf, reasoner). Lazily instantiated.
  // Client namespaces (schema, display, geo, explore) are inherited from
  // Ontologize. The former flat methods remain as deprecated delegates,
  // installed via installFlatApi() at the bottom of this file.
  // ==========================================================================

  /**
   * `archive` namespace — mongodump / mongorestore. See {@link ArchiveApi}.
   * @returns {ArchiveApi}
   */
  get archive() {
    return this._archiveApi ??= new ArchiveApi(this);
  }

  /**
   * `rdf` namespace — RDF/SPARQL serialization and HyLAR fact assembly.
   * See {@link RdfApi}.
   * @returns {RdfApi}
   */
  get rdf() {
    return this._rdfApi ??= new RdfApi(this);
  }

  /**
   * `io` namespace — JSON-LD import/export and bootstrap. See {@link IoApi}.
   * @returns {IoApi}
   */
  get io() {
    return this._ioApi ??= new IoApi(this);
  }

  /**
   * `reasoner` namespace — HyLAR reasoning integration and process management.
   * See {@link ReasonerApi}.
   * @returns {ReasonerApi}
   */
  get reasoner() {
    return this._reasonerApi ??= new ReasonerApi(this);
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
    //
    // The line this list draws is *what the resource says something about*, not
    // whether it looks like OWL. A type belongs here when the resource
    // describes the schema — a class, a property, a property's characteristics,
    // an axiom relating classes. It does NOT belong here when the resource
    // describes individuals, however OWL-flavoured its type is:
    // `owl:NamedIndividual`, `owl:AllDifferent` and
    // `owl:NegativePropertyAssertion` are all assertions about instances, and
    // classifying them as TBox would move real instance data into the ontology
    // collection and out of reasoning's reach.
    //
    // Getting an omission wrong in the other direction is quiet rather than
    // loud: a TBox node missing from this list is routed to the ABox catch-all,
    // where it is an instance of nothing. The reasoner derives nothing about it,
    // so `reasonCollection` never stamps it `bold:reasoned`, so every pass
    // re-selects it and reports it as permanently unreasoned. BFO's five
    // `owl:AllDisjointClasses` blank nodes did exactly this — they were the
    // entire residue of a full Critter Track rebuild.
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
      "owl:InverseFunctionalProperty", "http://www.w3.org/2002/07/owl#InverseFunctionalProperty",

      // Axiom nodes. Usually blank nodes carrying only `owl:members`, so no
      // other type is available to route them by.
      "owl:AllDisjointClasses", "http://www.w3.org/2002/07/owl#AllDisjointClasses",
      "owl:AllDisjointProperties", "http://www.w3.org/2002/07/owl#AllDisjointProperties",

      // Property characteristics. Every one of these in the current corpus is
      // co-typed `owl:ObjectProperty` and so already routed correctly — by
      // accident of the co-typing, not by this list. A property declared with
      // only its characteristic would have fallen through.
      "owl:TransitiveProperty", "http://www.w3.org/2002/07/owl#TransitiveProperty",
      "owl:SymmetricProperty", "http://www.w3.org/2002/07/owl#SymmetricProperty",
      "owl:AsymmetricProperty", "http://www.w3.org/2002/07/owl#AsymmetricProperty",
      "owl:ReflexiveProperty", "http://www.w3.org/2002/07/owl#ReflexiveProperty",
      "owl:IrreflexiveProperty", "http://www.w3.org/2002/07/owl#IrreflexiveProperty"
    ];

    return types.some(type => ontologyTypes.includes(type));
  }

  /**
   * Resolve the appropriate collection for a resource.
   *
   * Resolution order:
   * 1. Statement resources -> statements collection
   * 2. TBox resources -> ontology collection
   * 3. typeCollections — match on @type
   * 4. idResolvers — match on _id prefix/pattern
   * 5. namespace — _id prefix matches a registered collection name
   * 6. default — typeCollections["*"]
   * 7. fallback — ontology collection
   *
   * @param {object} resource - Resource with _id and @type
   * @param {object} [opts]
   * @param {boolean} [opts.useNamespaceCollections=true]
   * @param {boolean} [opts.aboxOnly=false] - Skip Statement/TBox checks, return null if no ABox match
   * @returns {Promise<{collection: Collection, name: string}|null>} null when aboxOnly and no match
   */
  async getCollectionForResource(resource, opts = {}) {
    const useNamespaceCollections = opts.useNamespaceCollections !== false;
    const aboxOnly = opts.aboxOnly === true;

    if (!aboxOnly) {
      // Statements
      if (this.isStatementResource(resource)) {
        return { collection: this.collections.statements, name: "statements" };
      }

      // TBox
      if (await this.isTBoxResource(resource)) {
        return { collection: this.collections.ontology, name: "ontology" };
      }
    }

    // ABox resolution chain
    const defaultAboxCollection = this.opts.typeCollections?.["*"];

    // 1. typeCollections
    if (this.opts.typeCollections) {
      for (const typ of (resource["@type"] ?? [])) {
        const colName = this.opts.typeCollections[typ];
        if (colName && this.collections[colName]) {
          return { collection: this.collections[colName], name: colName };
        }
      }
    }

    // 2. idResolvers
    const prefix = resource._id?.match(/^([^:]+):/)?.[1];
    if (prefix && this.opts.idResolvers?.[prefix]) {
      const resolvers = this.opts.idResolvers[prefix];
      if (Array.isArray(resolvers)) {
        for (const resolver of resolvers) {
          if (resolver.match && resolver.collection) {
            const re = new RegExp(resolver.match);
            if (resource._id.match(re) && this.collections[resolver.collection]) {
              return { collection: this.collections[resolver.collection], name: resolver.collection };
            }
          }
        }
      }
    }

    // 3. namespace
    if (prefix && useNamespaceCollections && this.collections[prefix]) {
      return { collection: this.collections[prefix], name: prefix };
    }

    // 4. default
    if (defaultAboxCollection && this.collections[defaultAboxCollection]) {
      return { collection: this.collections[defaultAboxCollection], name: defaultAboxCollection };
    }

    // 5. fallback
    if (aboxOnly) {
      return null;
    }
    return { collection: this.collections.ontology, name: "ontology" };
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
   * Clear the JSON property cache (call when ontology changes).
   * Delegates to the shared JsonPropertyStore (this._jsonProps).
   */
  clearJsonPropertyCache() {
    this._jsonProps.clear();
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
   * @param {boolean} [opts.persistAllSubjects=false] - persist inferences for ALL affected
   *   subjects (e.g. transitively-affected subclasses), not just resourceId. Other subjects
   *   are merged into their existing resources only (never inserted).
   * @param {boolean} [opts.updateResources=true] - when persistAllSubjects is set, also
   *   persist the other affected subjects; set false to compute them without writing.
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
    let affectedSubjects = [];

    if (opts.reasoning) {
      await this.reasoner.ensureReasoner(opts);
    }

    if (opts.reasoning) {
      console.log("Applying reasoning to update...");

      // Convert updated resource to triples
      const triples = await this.rdf.getTriplesForResources([updatedResource], {
        blankNodes: true,
        includeStatements: false
      });
      const sparqlInsert = await this.rdf.createSparqlInsert(triples);

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
          const facts = this.rdf._derivationsToFacts(derivations.additions);
          const context = await this.getContext();

          // By default capture inferences only for the updated resource. With
          // persistAllSubjects, capture inferences for EVERY affected subject (e.g. a
          // subclass that inherits new superclasses transitively).
          let selectedFacts;
          if (opts.persistAllSubjects) {
            selectedFacts = facts;
          }
          else {
            const expandedResourceId = this.ld().expandQName(resourceId, context);
            selectedFacts = facts.filter(f => f.subject === expandedResourceId);
          }

          if (selectedFacts.length > 0) {
            // Assemble facts into resources (keyed by compacted id)
            const assembled = await this.rdf.assembleFactsIntoResources(selectedFacts, { context });
            inferredProperties = assembled[resourceId] || {};

            // Persist inferences for OTHER affected subjects. The updated resource is
            // written below via finalResource, so exclude it here. updateOnly: never
            // insert new documents for inferred-but-unknown subjects.
            if (opts.persistAllSubjects && opts.updateResources !== false) {
              const others = { ...assembled };
              delete others[resourceId];
              if (Object.keys(others).length > 0) {
                affectedSubjects = await this.reasoner._mergeAndUpdateResources(others, collection, { updateOnly: true });
                console.log(`Persisted inferences for ${affectedSubjects.length} other affected subject(s): ${affectedSubjects.join(", ")}`);
              }
            }

            // Create statements for inferred facts. Statement ids are content
            // hashes, so a repeat update over unchanged data upserts the same
            // documents rather than accumulating copies. The single-entry
            // partition map gives the updated resource's inferences the same
            // dcterms:isPartOf the resource carries; inferences about OTHER
            // affected subjects (persistAllSubjects) get none.
            statements = await this.rdf.createStatementsForFacts(selectedFacts, {
              onlyInferred: true,
              subjectPartitions: updatedResource["dcterms:isPartOf"] !== undefined
                ? { [resourceId]: updatedResource["dcterms:isPartOf"] }
                : {},
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
              await this.reasoner._persistStatements(statements);
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
    finalResource["bold:reasoned"] = new Date().toISOString();
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
      affectedSubjects,
      statements: opts.includeStatements ? statements : undefined
    };
  }


}

// Constants
OntologizeServer.TYPE_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// Install deprecated flat-API delegates for the server methods
// (ontologizeServer.bootstrap(), .reasonCollection(), etc.) that forward to
// their namespace method. Each entry installs only once its real method has
// been extracted (see installFlatApi's hasOwnProperty guard). Remove in a
// later release once downstream consumers have migrated. See src/api/flatApi.js.
installFlatApi(OntologizeServer.prototype, SERVER_FLAT_API);

// Export the extended class as default
export default OntologizeServer;
