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
   * @param {object} ontologyCollection
   * @param {object} contextCollection
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
    this.opts.context = this.opts.context || {};
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
   * Extract classes from an ontology resource
   *
   * @param {object} resource - The ontology resource
   * @returns {Array} Array of class resources
   */
  extractClasses(resource) {
    check(resource, Object);

    const classes = [];
    const classTypes = ["owl:Class", "rdfs:Class"];

    // If this resource itself is a class
    if (resource["@type"] && classTypes.some(type =>
      Array.isArray(resource["@type"]) ?
        resource["@type"].includes(type) :
        resource["@type"] === type
    )) {
      classes.push(resource);
      return classes; // Return early to avoid duplicates
    }

    return classes;
  }

  /**
   * Extract properties from an ontology resource
   *
   * @param {object} resource - The ontology resource
   * @returns {Array} Array of property resources
   */
  extractProperties(resource) {
    check(resource, Object);

    const properties = [];
    const propertyTypes = ["owl:ObjectProperty", "owl:DatatypeProperty", "owl:AnnotationProperty", "rdf:Property"];

    // If this resource itself is a property
    if (resource["@type"] && propertyTypes.some(type =>
      Array.isArray(resource["@type"]) ?
        resource["@type"].includes(type) :
        resource["@type"] === type
    )) {
      properties.push(resource);
      return properties; // Return early to avoid duplicates
    }

    return properties;
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
      const parts = id.split(/[#\/:]/);
      return parts[parts.length - 1];
    }

    return fallback || "Unknown";
  }

  /**
   * Get module version
   *
   * @returns {string} The module version
   */
  getVersion() {
    return this.version;
  }
}

// Export the class as default
export default Ontologize;
