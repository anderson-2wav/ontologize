/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import crypto from "node:crypto";
import { check, Match } from "../../lib/check.js";
import _ from "lodash";
import jsonPath from "../../lib/jsonpath.js";
import { ApiNamespace } from "../ApiNamespace.js";

/**
 * `ontologizeServer.rdf` — RDF/SPARQL serialization: convert BOLD resources to
 * triples, build SPARQL INSERT strings, and assemble HyLAR facts back into
 * resources and rdf:Statement reifications. Reads context/LD and the JSON-property
 * store through the owning instance.
 */
export class RdfApi extends ApiNamespace {
  // Expanded rdf reification term names, accepted alongside the compacted forms
  // wherever a statement document is read (see _statementIdForResource).
  static RDF_SUBJECT = "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject";
  static RDF_PREDICATE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate";
  static RDF_OBJECT = "http://www.w3.org/1999/02/22-rdf-syntax-ns#object";

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

    // The yield cadence lives on the owning server instance's class.
    const yieldEvery = this.ontologize.constructor.YIELD_EVERY;

    console.log(`Converting ${resources.length} resources to triples...`);
    // For BOLD, we generally don't want to create triples for embedded statements
    // In BOLD, we use "bold:" namespace instead of "ctb:"
    if (!opts.includeStatements) {
      let stripped = 0;
      for (const r of resources) {
        this._stripEmbeddedStatements(r);
        if (++stripped % yieldEvery === 0) await this.ontologize._yieldToEventLoop();
      }
    }

    // Strip properties with JSON values — they cannot be represented as triples.
    //
    // Resolve the question once per DISTINCT KEY, not once per resource-key
    // pair. _isJsonProperty deliberately does not cache a negative answer (the
    // ontology may not be loaded yet, so "unknown property" now can become
    // "JSON property" later), which means every key without an ontology
    // definition costs a findOne — and a collar report carries ten of them
    // (_h3, _h3_3.._h3_11, _geohash, _whenMs, geohash). Per 1,000-resource
    // batch that was ~10,000 sequential round trips; it is now one per key.
    const candidateKeys = new Set();
    for (const r of resources) {
      for (const key of Object.keys(r)) {
        if (key[0] === "@" || key === "_id") continue;
        candidateKeys.add(key);
      }
    }

    const jsonKeys = [];
    for (const key of candidateKeys) {
      if (await this.ontologize._jsonProps._isJsonProperty(key)) jsonKeys.push(key);
    }

    if (jsonKeys.length) {
      let checked = 0;
      for (const r of resources) {
        for (const key of jsonKeys) {
          if (key in r) delete r[key];
        }
        if (++checked % yieldEvery === 0) await this.ontologize._yieldToEventLoop();
      }
    }

    // Get the context from the Context collection (which should have _id: "@id" mapping)
    const contextForExpansion = await this.ontologize.getContext(opts.context);

    console.log(`Expand ${resources.length} resources...`);
    let ct = 0;
    const ld = this.ld();

    // Expand in chunks with a yield between them. ld.expand runs to completion
    // without yielding, so expanding a whole batch in one call blocks every
    // socket and timer in the process for the duration.
    const expanded = [];
    for (let i = 0; i < resources.length; i += yieldEvery) {
      const chunk = resources.slice(i, i + yieldEvery);
      expanded.push(...await ld.expand(chunk, contextForExpansion, { flatten: true }));
      if (i + yieldEvery < resources.length) await this.ontologize._yieldToEventLoop();
    }
    // for..of rather than forEach: this loop is pure CPU over every property of
    // every resource, and without an await inside it the process cannot answer
    // an HTTP request or a DDP message until the whole batch is triplified.
    for (const resource of expanded) {
      ct++;
      if (ct % 100 === 0) {
        console.log(`Triplified ${ct} resources...`);
      }
      if (ct % yieldEvery === 0) await this.ontologize._yieldToEventLoop();
      for (const key in resource) {
        let p = key;
        if (key === "@type") {
          p = this.ontologize.constructor.TYPE_URI;
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
    }
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
    const context = await this.ontologize.getContext(opts.context);

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

    const context = await this.ontologize.getContext(opts.context);
    const compact = opts.compact !== false;

    console.log(`🔄 Assembling ${facts.length} facts into JSON-LD resources...`);

    const resources = {};

    // Step 1: Group facts by subject into JSON-LD objects
    facts.forEach(fact => {
      // HACKERY
      // for reasons unknown at the moment, string values are coming across quoted...
      let rr = fact.subject.match(/^"(.*)"$/s);
      if (rr) {
        // console.log(`fact.subject ${fact.subject} appears quoted.`);
        fact.subject = rr[1];
      }
      rr = fact.object.match(/^"(.*)"$/s);
      if (rr) {
        // console.log(`fact.object for ${fact.subject} appears quoted:`, fact.object);
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
   * Build the deterministic `_id` for a reification statement.
   *
   * The id is a content hash of the reified triple plus a provenance
   * discriminator, so re-reasoning the same data mints the same id and the write
   * path can upsert instead of inserting a duplicate (see
   * statement-idempotency-spec.md §1).
   *
   * `source` distinguishes statements that reify the *same* triple from
   * different provenance — a hand-authored import statement and a reasoner
   * inference about `dwc:Dataset rdfs:subClassOf bfo:immaterial-entity` stay
   * separate documents rather than clobbering each other. Callers pass the
   * subject's `dcterms:isPartOf` when it has one, else `bold:provenance`, else
   * nothing. Array sources are sorted before joining so the value is
   * order-independent.
   *
   * 16 hex chars = 64 bits, ample against collision for this collection.
   *
   * @param {string} subject - compacted `rdf:subject`
   * @param {string} predicate - compacted `rdf:predicate`
   * @param {string|number|boolean} object - compacted `rdf:object`
   * @param {string|string[]} [source] - provenance discriminator
   * @returns {string} `bold:stmt-<16 hex chars>`
   */
  _statementId(subject, predicate, object, source) {
    const src = Array.isArray(source)
      ? [...source].map(String).sort().join(",")
      : (source === undefined || source === null ? "" : String(source));
    const hash = crypto.createHash("sha1")
      .update(`${subject}|${predicate}|${object}|${src}`)
      .digest("hex")
      .slice(0, 16);
    return `bold:stmt-${hash}`;
  }

  /**
   * Reduce one `rdf:subject`/`predicate`/`object` value to the single scalar the
   * id hashes over.
   *
   * The same triple has to hash identically whichever path built it, and the two
   * paths do not hand over identical shapes: the reasoner passes bare scalars,
   * while a statement read back from an import has been through
   * `ld.compact(..., { ensureArrayProps: true })` and may carry
   * `["nice:K0865"]` or `{"@id": "nice:K0865"}` instead. Unwrapping here is what
   * makes an imported statement and a reasoner inference about the same triple
   * agree on their id.
   *
   * @param {*} value - the raw property value
   * @returns {string|null} the scalar to hash, or null if there is nothing usable
   * @private
   */
  _statementTerm(value) {
    if (value === undefined || value === null) {
      return null;
    }
    if (Array.isArray(value)) {
      const terms = value.map(v => this._statementTerm(v)).filter(v => v !== null);
      if (terms.length === 0) return null;
      if (terms.length === 1) return terms[0];
      // Multi-valued s/p/o is malformed for a reification, but sorting keeps the
      // id stable rather than order-dependent.
      return terms.sort().join(",");
    }
    if (typeof value === "object") {
      if (Object.prototype.hasOwnProperty.call(value, "@id")) return this._statementTerm(value["@id"]);
      if (Object.prototype.hasOwnProperty.call(value, "@value")) return this._statementTerm(value["@value"]);
      return null;
    }
    return String(value);
  }

  /**
   * Deterministic `_id` for an existing statement *document*, derived from the
   * document itself: its reified triple plus `dcterms:isPartOf` (else
   * `bold:provenance`) as the provenance discriminator.
   *
   * Used by the import path to replace whatever `_id` a source file supplied
   * (`nice:K0865-K0377`, say) with a content hash, so re-importing the same
   * statement addresses the same document — and by `_persistStatements` as its
   * fallback when a caller hands over a statement with no id.
   *
   * Accepts both compacted and expanded rdf term names, matching what
   * `Ontologize.isStatementResource` recognizes.
   *
   * @param {object} statement - a statement document
   * @returns {string|null} the id, or null if the document carries no complete
   *   triple to hash (a resource typed `rdf:Statement` but missing an s/p/o)
   */
  _statementIdForResource(statement) {
    check(statement, Object);

    const term = (compact, expanded) =>
      this._statementTerm(statement[compact] ?? statement[expanded]);

    const subject = term("rdf:subject", RdfApi.RDF_SUBJECT);
    const predicate = term("rdf:predicate", RdfApi.RDF_PREDICATE);
    const object = term("rdf:object", RdfApi.RDF_OBJECT);

    if (subject === null || predicate === null || object === null) {
      return null;
    }

    const source = statement["dcterms:isPartOf"] ?? statement["bold:provenance"];
    return this._statementId(subject, predicate, object, source);
  }

  /**
   * Create Statement objects from HyLAR reasoning facts

   * @param {Object[]} facts - Array of HyLAR fact objects
   * @param {Object} opts - Options
   * @param {Object} opts.context - JSON-LD context for URI compaction
   * @param {Object} opts.metaPropsByPredicate - Additional metadata properties by predicate
   * @param {boolean} opts.onlyInferred - Only process inferred facts (default: true)
   * @param {string[]} opts.onlySubjects - Only process facts for these subjects
   * @param {Object} [opts.subjectPartitions] - map of compacted subject id →
   *   the subject resource's `dcterms:isPartOf`. A reasoning statement inherits
   *   the partition of the resource it describes, which is what makes
   *   `deleteMany({"dcterms:isPartOf": …})` a clean way to drop a partition's
   *   inferences. Callers that hold the reasoned resources build this map;
   *   the TBox path leaves it unset (ontology resources have no data partition).
   * @returns {Promise<Object[]>} Array of Statement objects
   */
  async createStatementsForFacts(facts, opts = {}) {
    check(facts, Array);
    check(opts, Match.Optional(Object));

    opts = {
      onlyInferred: opts.onlyInferred !== false,
      metaPropsByPredicate: opts.metaPropsByPredicate || {},
      ...opts
    };
    const subjectPartitions = opts.subjectPartitions || {};
    console.log(`Creating statements for ${facts.length} facts`);

    const context = opts.context || await this.ontologize.getContext();
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
        if (allPreds["bold:provenance"]) {
          statement["bold:provenance"] = allPreds["bold:provenance"];
        }

        // Add predicate-specific metadata
        const predProps = opts.metaPropsByPredicate[statement["rdf:predicate"]];
        if (predProps) {
          Object.keys(predProps).forEach((metaPred) => {
            statement[metaPred] = predProps[metaPred];
          });
        }

        // A reasoning statement inherits the partition of the subject resource
        // it describes. Set before the id: the partition is also the id's
        // provenance discriminator.
        const partition = subjectPartitions[statement["rdf:subject"]];
        if (partition !== undefined && partition !== null) {
          statement["dcterms:isPartOf"] = partition;
        }

        // Deterministic, content-addressed id: re-reasoning the same triple from
        // the same source yields the same _id, so _persistStatements upserts in
        // place instead of inserting a duplicate.
        statement._id = this._statementId(
          statement["rdf:subject"],
          statement["rdf:predicate"],
          statement["rdf:object"],
          statement["dcterms:isPartOf"] ?? statement["bold:provenance"]
        );

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

    // No "only new" pre-filter: deterministic ids make the write path an upsert,
    // so an already-recorded statement costs a no-op update rather than a
    // duplicate document. The old per-statement findOne check is redundant.
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
}

export default RdfApi;
