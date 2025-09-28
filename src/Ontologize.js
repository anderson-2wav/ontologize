/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

import { check, Match } from "./lib/check.js";
import jsonPath from "./lib/jsonpath.js";

/**
 * Ontologize - Utilities for working with ontology data in JSON-LD format
 *
 * This module provides client/server safe functions for ontology processing.
 * Server-only functions are available via "ontologize/server" import.
 *
 * @class
 */
export class Ontologize {
  /**
   * Create a new Ontologize instance
   *
   * @param {object} ontologyCollection - Collection adapter or raw MongoDB collection
   * @param {object} contextCollection - Collection adapter or raw MongoDB collection
   * @param {object} [opts] - Configuration options
   * @param {object} [opts.collections] - named collections in addition to ontology and context
   * @param {object} [opts.context] - Default JSON-LD context
   * @param {boolean} [opts.debug=false] - Enable debug logging
   */
  constructor(ontologyCollection, contextCollection, opts = {}) {
    check(ontologyCollection, Object);
    check(contextCollection, Object);

    this.collections = {
      Ontology: ontologyCollection,
      Context: contextCollection
    };

    this.opts = opts;
    this.opts.defaultContext = this.opts.defaultContext || Ontologize.DEFAULT_CONTEXT;
    this.opts.debug = this.opts.debug || false;
    if (this.opts.collections) {
      Object.assign(this.collections, this.opts.collections);
    }
    this.version = "0.1.0";
  }

  /**
   * Validate that a resource is a valid ontology resource
   *
   * @param {object} resource - The resource to validate
   * @returns {boolean} True if valid ontology resource
   */
  isValidOntologyResource(resource) {
    check(resource, Object);

    // Must have @id
    if (!resource["@id"]) {
      return false;
    }

    // Must have @type
    if (!resource["@type"]) {
      return false;
    }

    return true;
  }



  /**
   * Get the label for a resource, preferring rdfs:label
   *
   * @param {object} resource - The resource
   * @param {string} [fallback] - Fallback if no label found
   * @returns {string} The label or fallback
   */
  getLabel(resource, fallback) {
    check(resource, Object);
    check(fallback, Match.Optional(String));

    if (resource["rdfs:label"]) {
      return Array.isArray(resource["rdfs:label"]) ?
        resource["rdfs:label"][0] :
        resource["rdfs:label"];
    }

    if (resource["@id"]) {
      // Try to extract a readable name from the ID
      const id = resource["@id"];
      const parts = id.split(/[#/:]/);
      return parts[parts.length - 1];
    }

    return fallback || "Unknown";
  }

  /**
   * Get the label for a resource by looking it up from the ontology collection
   *
   * @param {string} resourceId - The resource ID to look up
   * @param {string} [fallback] - Fallback if no resource or label found
   * @returns {Promise<string>} The label or fallback
   */
  async getLabelFromId(resourceId, fallback) {
    check(resourceId, String);
    check(fallback, Match.Optional(String));

    try {
      // Look up the resource from the ontology collection
      const resource = await this.collections.Ontology.findOne({ _id: resourceId });

      if (resource) {
        // Use the synchronous getLabel method on the found resource
        return this.getLabel(resource, fallback);
      }
    }
    catch (error) {
      console.warn(`Failed to lookup resource ${resourceId}: ${error.message}`);
    }

    // If lookup failed or resource not found, extract from ID as fallback
    const parts = resourceId.split(/[#/:]/);
    const extractedLabel = parts[parts.length - 1];

    return extractedLabel || fallback || "Unknown";
  }

  /**
   * Get context for compaction from provided context, Context collection, or default
   *
   * @param {object} [providedContext] - Optional context to use instead of collection/default
   * @returns {Promise<object>} Context object for JSON-LD operations
   */
  async getContext(providedContext = null) {
    // Use provided context if available
    if (providedContext) {
      return providedContext;
    }

    // Try to get context from Context collection
    try {
      const contextDoc = await this.collections.Context.findOne({ _id: "@id" });
      if (contextDoc) {
        // TODO why do we do that? I think _id: "@id" is part of the context
        // Extract context data (excluding _id)
        // const { _id, ...contextData } = contextDoc;

        // Only use context from collection if it has meaningful data
        // if (Object.keys(contextData).length > 0) {
        //   return contextData;
        // }
      }
      return contextDoc;
    }
    catch (error) {
      console.warn(`Failed to load context from Context collection: ${error.message}`);
    }

    // Fall back to default ontology context
    return this.opts.defaultContext || Ontologize.DEFAULT_CONTEXT;
  }

  /**
   * Determine if a property should be treated as an array based on context and ontology information
   *
   * @param {string|object} property - The property ID (string) or resource object to check
   * @param {object} [opts] - Optional parameters
   * @param {object} [opts.context] - Current JSON-LD context to check
   * @param {boolean} [opts.cached=true] - Whether to use cached results
   * @returns {Promise<boolean>} True if property should be treated as an array
   */
  async isArrayProperty(property, opts = {}) {
    check(property, Match.OneOf(String, Object));
    check(opts, Match.Optional(Object));

    opts.cached = opts.cached !== false;

    let propertyId;
    let propertyResource = null;

    // Handle both string ID and resource object
    if (typeof property === "string") {
      propertyId = property;
      // Skip special properties
      if (propertyId === "__proto__" || propertyId.match(/^\d+$/)) {
        return false;
      }
    }
    else {
      // property is a resource object
      propertyResource = property;
      propertyId = property._id || property["@id"];
      if (!propertyId) {
        return false; // No valid ID found
      }
      // Skip special properties
      if (propertyId === "__proto__" || propertyId.match(/^\d+$/)) {
        return false;
      }
    }

    // Check current context for @container
    if (opts.context && opts.context[propertyId] && opts.context[propertyId]["@container"]) {
      const container = opts.context[propertyId]["@container"];
      return container === "@list" || container === "@set";
    }

    // Check global context
    try {
      const globalContext = await this.getContext();
      if (globalContext[propertyId] && globalContext[propertyId]["@container"]) {
        const container = globalContext[propertyId]["@container"];
        return container === "@list" || container === "@set";
      }
    }
    catch (error) {
      console.warn(`Failed to get global context: ${error.message}`);
    }

    // If we have the resource object directly, check it for bold:container
    if (propertyResource && propertyResource["bold:container"]) {
      const container = propertyResource["bold:container"];
      return container === "@list" || container === "@set";
    }

    // If we don't have the resource object, check ontology collection for bold:container property
    if (!propertyResource) {
      try {
        const ontologyResource = await this.collections.Ontology.findOne({ _id: propertyId });
        if (ontologyResource && ontologyResource["bold:container"]) {
          const container = ontologyResource["bold:container"];
          return container === "@list" || container === "@set";
        }
      }
      catch (error) {
        console.warn(`Failed to check ontology for property ${propertyId}: ${error.message}`);
      }
    }

    return false;
  }

  /**
   * Get module version
   *
   * @returns {string} The module version
   */
  getVersion() {
    return this.version;
  }

  static DEFAULT_CONTEXT = {
    "@vocab" : "https://ontology.2wav.com#",
    "rdf" : "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs" : "http://www.w3.org/2000/01/rdf-schema#",
    "owl" : "http://www.w3.org/2002/07/owl#",
    "xsd" : "http://www.w3.org/2001/XMLSchema#",
    "foaf" : "http://xmlns.com/foaf/0.1/",
    "dc" : "http://purl.org/dc/elements/1.1/",
    "org" : "http://www.w3.org/ns/org#",
    "uo" : "http://purl.obolibrary.org/obo/uo.owl",
    "xbfo" : "http://purl.obolibrary.org/obo/bfo.owl",
    "obo" : "http://purl.obolibrary.org/obo/",
    "2wav" : "https://ontology.2wav.com#",
    "2do" : "https://ontology.2wav.com/display#",
    "bfo" : "https://ontology.2wav.com/bfo#",
    "ctb" : "https://ontology.2wav.com/bridge#",
    "ctl" : "https://ontology.2wav.com/800-53#",
    "ctl5" : "https://ontology.2wav.com/800-53/rev5#",
    "nice" : "https://ontology.2wav.com/nice#",
    "acrt" : "https://privatealpha.com/ontology/certification/1#",
    "time" : "http://www.w3.org/2006/time#",
    "skos" : "http://www.w3.org/2004/02/skos/core#",
    "wot" : "http://xmlns.com/wot/0.1/",
    "vs" : "http://www.w3.org/2003/06/sw-vocab-status/ns#",
    "brick": "https://brickschema.org/schema/Brick#",
    "csvw": "http://www.w3.org/ns/csvw#",
    "dcam": "http://purl.org/dc/dcam/",
    "dcat": "http://www.w3.org/ns/dcat#",
    "dcmitype": "http://purl.org/dc/dcmitype/",
    "dcterms": "http://purl.org/dc/terms/",
    "doap": "http://usefulinc.com/ns/doap#",
    "odrl": "http://www.w3.org/ns/odrl/2/",
    "prof": "http://www.w3.org/ns/dx/prof/",
    "prov": "http://www.w3.org/ns/prov#",
    "qb": "http://purl.org/linked-data/cube#",
    "schema": "https://schema.org/",
    "sh": "http://www.w3.org/ns/shacl#",
    "sosa": "http://www.w3.org/ns/sosa/",
    "ssn": "http://www.w3.org/ns/ssn/",
    "vann": "http://purl.org/vocab/vann/",
    "void": "http://rdfs.org/ns/void#",
    "_id" : "@id",
    "rdfs:range" : {
      "@type" : "@id"
    },
    "rdfs:domain" : {
      "@type" : "@id"
    },
    "ctb:importance" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#integer"
    },
    "ctb:when" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#dateTime"
    },
    "rdfs:comment" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "ctb:confidence" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "ctb:hasBeginning" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#dateTime"
    },
    "ctb:hasCertification" : {
      "@type" : "@id"
    },
    "ctb:hasEnd" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#dateTime"
    },
    "ctb:hasKnowledge" : {
      "@type" : "@id"
    },
    "ctb:hasPosition" : {
      "@type" : "@id"
    },
    "ctb:hasSkill" : {
      "@type" : "@id"
    },
    "ctb:hasTask" : {
      "@type" : "@id"
    },
    "ctb:jobTitle" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "org:memberDuring" : {
      "@type" : "@id"
    },
    "org:memberOf" : {
      "@type" : "@id"
    },
    "org:organization" : {
      "@type" : "@id"
    },
    "org:role" : {
      "@type" : "@id"
    },
    "rdfs:subClassOf" : {
      "@type" : "@id"
    },
    "2do:schema" : {

    },
    "dc:description" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "ctb:collection" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "ctb:completedDate" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#dateTime"
    },
    "ctb:dueDate" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#dateTime"
    },
    "ctb:projectStatus" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "ctb:severity" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#string"
    },
    "ctb:startDate" : {
      "@type" : "http://www.w3.org/2001/XMLSchema#dateTime"
    },
    "schema:eligibleRegion" : {

    },
    "rdfs:subPropertyOf" : {
      "@type" : "@id"
    },
    "vs:term_status" : {
      "@type" : "@id"
    },
    "wot:assurance" : {
      "@type" : "@id"
    },
    "wot:src_assurance" : {
      "@type" : "@id"
    },
    "nice:description" : {

    },
    "nice:inCategory" : {
      "@type" : "@id"
    },
    "nice:inSpecialtyArea" : {
      "@type" : "@id"
    },
    "nice:name" : {

    },
    "nice:abbrev" : {

    },
    "nice:requiresAbility" : {
      "@type" : "@id"
    },
    "nice:requiresKnowledge" : {
      "@type" : "@id"
    },
    "nice:requiresSkill" : {
      "@type" : "@id"
    },
    "nice:requiresTask" : {
      "@type" : "@id"
    },
    "nice:title" : {

    },
    "nice:competencyType" : {
      "@type" : "@id"
    },
    "ctl:related" : {
      "@type" : "@id"
    },
    "ctl:memberOf": {
      "@type" : "@id"
    },
    "owl:sameAs" : {
      "@type" : "@id"
    },
    "owl:cardinality": {
      "@type": "http://www.w3.org/2001/XMLSchema#integer"
    },
    "owl:maxCardinality": {
      "@type": "http://www.w3.org/2001/XMLSchema#integer"
    },
    "owl:allValuesFrom": {
      "@type" : "@id"
    },
    "owl:onProperty": {
      "@type" : "@id"
    },
    "owl:unionOf": {
      "@type" : "@id"
    },
    "owl:intersectionOf": {
      "@type" : "@id"
    },
    "owl:disjointWith": {
      "@type" : "@id"
    },
  };
  static DEFAULT_CONTEXT2 = {
    _id: "@id",
    "@vocab": "https://ontology.2wav.com#",
    acrt: "https://privatealpha.com/ontology/certification/1#",
    bfo: "https://ontology.2wav.com/bfo#",
    bold: "https://ontology.2wav.com/bold#",
    brick: "https://brickschema.org/schema/Brick#",
    bui: "https://ontology.2wav.com/bold-ui#",
    csvw: "http://www.w3.org/ns/csvw#",
    ctb: "https://ontology.2wav.com/bridge#",
    ctl: "https://ontology.2wav.com/800-53#",
    ctl5: "https://ontology.2wav.com/800-53/rev5#",
    dc: "http://purl.org/dc/elements/1.1/",
    dcam: "http://purl.org/dc/dcam/",
    dcat: "http://www.w3.org/ns/dcat#",
    dcmitype: "http://purl.org/dc/dcmitype/",
    dcterms: "http://purl.org/dc/terms/",
    doap: "http://usefulinc.com/ns/doap#",
    foaf: "http://xmlns.com/foaf/0.1/",
    nice: "https://ontology.2wav.com/nice#",
    obo: "http://purl.obolibrary.org/obo/",
    odrl: "http://www.w3.org/ns/odrl/2/",
    org: "http://www.w3.org/ns/org#",
    owl: "http://www.w3.org/2002/07/owl#",
    prof: "http://www.w3.org/ns/dx/prof/",
    prov: "http://www.w3.org/ns/prov#",
    qb: "http://purl.org/linked-data/cube#",
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    schema: "https://schema.org/",
    sh: "http://www.w3.org/ns/shacl#",
    skos: "http://www.w3.org/2004/02/skos/core#",
    sosa: "http://www.w3.org/ns/sosa/",
    ssn: "http://www.w3.org/ns/ssn/",
    time: "http://www.w3.org/2006/time#",
    uo: "http://purl.obolibrary.org/obo/uo.owl",
    vann: "http://purl.org/vocab/vann/",
    void: "http://rdfs.org/ns/void#",
    vs: "http://www.w3.org/2003/06/sw-vocab-status/ns#",
    wot: "http://xmlns.com/wot/0.1/",
    wwav: "https://ontology.2wav.com#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    "bold:collection": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "bold:when": { "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "bui:schema": {},
    "ctb:completedDate": { "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "ctb:confidence": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "ctb:dueDate": { "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "ctb:hasBeginning": { "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "ctb:hasCertification": { "@type": "@id" },
    "ctb:hasEnd": { "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "ctb:hasKnowledge": { "@type": "@id" },
    "ctb:hasPosition": { "@type": "@id" },
    "ctb:hasSkill": { "@type": "@id" },
    "ctb:hasTask": { "@type": "@id" },
    "ctb:importance": { "@type": "http://www.w3.org/2001/XMLSchema#integer" },
    "ctb:jobTitle": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "ctb:projectStatus": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "ctb:severity": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "ctb:startDate": { "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "ctl:memberOf": { "@type": "@id" },
    "ctl:related": { "@type": "@id" },
    "dc:description": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "nice:abbrev": {},
    "nice:competencyType": { "@type": "@id" },
    "nice:description": {},
    "nice:inCategory": { "@type": "@id" },
    "nice:inSpecialtyArea": { "@type": "@id" },
    "nice:name": {},
    "nice:requiresAbility": { "@type": "@id" },
    "nice:requiresKnowledge": { "@type": "@id" },
    "nice:requiresSkill": { "@type": "@id" },
    "nice:requiresTask": { "@type": "@id" },
    "nice:title": {},
    "org:memberDuring": { "@type": "@id" },
    "org:memberOf": { "@type": "@id" },
    "org:organization": { "@type": "@id" },
    "org:role": { "@type": "@id" },
    "owl:cardinality": { "@type": "http://www.w3.org/2001/XMLSchema#integer" },
    "owl:maxCardinality": { "@type": "http://www.w3.org/2001/XMLSchema#integer" },
    "owl:sameAs": { "@type": "@id" },
    "rdfs:comment": { "@type": "http://www.w3.org/2001/XMLSchema#string" },
    "rdfs:domain": { "@type": "@id" },
    "rdfs:range": { "@type": "@id" },
    "rdfs:subClassOf": { "@type": "@id" },
    "rdfs:subPropertyOf": { "@type": "@id" },
    "schema:eligibleRegion": {},
    "vs:term_status": { "@type": "@id" },
    "wot:assurance": { "@type": "@id" },
    "wot:src_assurance": { "@type": "@id" }
  };
}

// Export the class as default
export default Ontologize;
