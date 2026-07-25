/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Statement idempotency & provenance (statement-idempotency-spec.md).
 *
 * Reasoning used to mint each statement `_id` with a random suffix and
 * `insertMany` it, so every pass duplicated statements it had already written.
 * Ids are now content hashes of (subject, predicate, object, source) and the
 * write path upserts, and reasoner statements inherit their subject's
 * `dcterms:isPartOf` so a partition's inferences can be dropped by provenance.
 */

import { assert } from "chai";
import { OntologizeServer } from "../src/OntologizeServer.js";

const TRACK_NS = "https://ontologize.2wav.com/ontology/track#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const CONTEXT_DOC = {
  _id: "@id",
  "@vocab": "https://ontologize.2wav.com/ontology/bold#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  dcterms: "http://purl.org/dc/terms/",
  track: TRACK_NS,
};

/** Minimal selector matcher — equality and `$in`, which is all these tests use. */
function matches(doc, query = {}) {
  return Object.entries(query).every(([key, cond]) => {
    if (cond && typeof cond === "object" && Array.isArray(cond.$in)) {
      return cond.$in.includes(doc[key]);
    }
    return doc[key] === cond;
  });
}

/**
 * In-memory statements collection with the write surface _persistStatements uses:
 * `bulkWrite` of `updateOne` upserts. Tracks upserted/modified counts the way the
 * driver does, so the "second write changes nothing" assertion is meaningful.
 */
function createStatementsStore() {
  const docs = new Map();
  return {
    docs,
    async findOne(query) {
      return [...docs.values()].find(d => matches(d, query)) || null;
    },
    find(query) {
      return { toArray: async () => [...docs.values()].filter(d => matches(d, query)) };
    },
    async countDocuments(query = {}) {
      return [...docs.values()].filter(d => matches(d, query)).length;
    },
    async deleteMany(query = {}) {
      const doomed = [...docs.values()].filter(d => matches(d, query));
      for (const d of doomed) docs.delete(d._id);
      return { deletedCount: doomed.length };
    },
    // The import path writes statements through _saveResourceWithMerge, which
    // replaces rather than upserting field-by-field.
    async replaceOne(query, doc) {
      const existed = docs.has(query._id);
      docs.set(query._id, doc);
      return { matchedCount: existed ? 1 : 0, modifiedCount: 1 };
    },
    count: () => docs.size,
    async bulkWrite(operations) {
      let upsertedCount = 0;
      let modifiedCount = 0;
      let matchedCount = 0;
      for (const op of operations) {
        const { filter, update, upsert } = op.updateOne;
        const existing = docs.get(filter._id);
        if (existing) {
          matchedCount++;
          const merged = { ...existing, ...update.$set };
          if (JSON.stringify(merged) !== JSON.stringify(existing)) {
            docs.set(filter._id, merged);
            modifiedCount++;
          }
        }
        else if (upsert) {
          docs.set(filter._id, { _id: filter._id, ...update.$set, ...update.$setOnInsert });
          upsertedCount++;
        }
      }
      return { upsertedCount, modifiedCount, matchedCount };
    },
  };
}

/** Empty read-only ontology collection (warmReasoner loads it and finds nothing). */
function createOntologyStore() {
  return {
    async findOne() { return null; },
    find() { return { toArray: async () => [], fetch: () => [] }; },
    async countDocuments() { return 0; },
  };
}

/** Writable document store for the import path (ontology / context targets). */
function createDocStore() {
  const docs = new Map();
  return {
    docs,
    async findOne(query) {
      return [...docs.values()].find(d => matches(d, query)) || null;
    },
    find(query = {}) {
      return { toArray: async () => [...docs.values()].filter(d => matches(d, query)) };
    },
    async replaceOne(query, doc) {
      const existed = docs.has(query._id);
      docs.set(query._id, doc);
      return { matchedCount: existed ? 1 : 0, modifiedCount: 1 };
    },
    async updateOne(query, update) {
      const existing = docs.get(query._id) || { _id: query._id };
      docs.set(query._id, { ...existing, ...update.$set });
      return { modifiedCount: 1 };
    },
    async deleteMany() {
      const deletedCount = docs.size;
      docs.clear();
      return { deletedCount };
    },
    async countDocuments() { return docs.size; },
    count: () => docs.size,
  };
}

/** Track collection holding reports, each tagged with its partition. */
function createTrackStore(resources) {
  const docs = new Map(resources.map(r => [r._id, r]));
  return {
    docs,
    async findOne(query) {
      return [...docs.values()].find(d => matches(d, query)) || null;
    },
    find(query = {}) {
      return {
        toArray: async () => [...docs.values()].filter((d) => {
          // reasonCollection's selector is {"bold:reasoned": {$exists:false}} plus
          // the caller's partition term.
          const { "bold:reasoned": reasoned, ...rest } = query;
          if (reasoned && reasoned.$exists === false && "bold:reasoned" in d) return false;
          return matches(d, rest);
        }),
      };
    },
    async countDocuments() { return docs.size; },
    async replaceOne(query, doc) {
      docs.set(query._id, doc);
      return { modifiedCount: 1 };
    },
    async insertOne(doc) {
      docs.set(doc._id, doc);
      return { insertedId: doc._id };
    },
  };
}

/**
 * One inferred HyLAR derivation: `report a track:Sighting`. `asString` is the
 * field createStatementsForFacts actually parses.
 */
function derivation(reportId, type = `${TRACK_NS}Sighting`) {
  const subject = `${TRACK_NS}${reportId}`;
  return {
    subject,
    predicate: RDF_TYPE,
    object: type,
    explicit: false,
    rule: {
      subject: "?x",
      predicate: "rdf:type",
      object: "track:CollarReport",
      axiom: "rdfs9",
      details: "test rule",
    },
    asString: `I(${subject}, ${RDF_TYPE}, ${type})`,
  };
}

describe("statement idempotency & provenance", function () {
  this.timeout(20000);

  let server;
  let statementsStore;
  let trackStore;

  beforeEach(async function () {
    statementsStore = createStatementsStore();
    trackStore = createTrackStore([
      {
        _id: "track:report-1",
        "@type": ["track:CollarReport"],
        "dcterms:isPartOf": "track:track-2025",
      },
      {
        _id: "track:report-2",
        "@type": ["track:CollarReport"],
        "dcterms:isPartOf": "track:track-2025",
      },
    ]);

    server = new OntologizeServer(
      createOntologyStore(),
      { findOne: async () => CONTEXT_DOC },
      statementsStore,
      { collections: { track: trackStore } }
    );
    await server.ready();
  });

  describe("_statementId", function () {
    it("is deterministic for the same triple and source", function () {
      const a = server.rdf._statementId("track:report-1", "rdf:type", "track:Sighting", "track:track-2025");
      const b = server.rdf._statementId("track:report-1", "rdf:type", "track:Sighting", "track:track-2025");
      assert.equal(a, b);
      assert.match(a, /^bold:stmt-[0-9a-f]{16}$/);
    });

    it("is order-independent for an array source", function () {
      const a = server.rdf._statementId("track:report-1", "rdf:type", "track:Sighting", ["a", "b"]);
      const b = server.rdf._statementId("track:report-1", "rdf:type", "track:Sighting", ["b", "a"]);
      assert.equal(a, b);
    });

    it("distinguishes the same triple from different sources", function () {
      const partitioned = server.rdf._statementId("dwc:Dataset", "rdfs:subClassOf", "bfo:immaterial-entity", "dwc:dwc-bfo");
      const reasoned = server.rdf._statementId("dwc:Dataset", "rdfs:subClassOf", "bfo:immaterial-entity", "bold:bootstrapReasoner");
      const sourceless = server.rdf._statementId("dwc:Dataset", "rdfs:subClassOf", "bfo:immaterial-entity");
      assert.notEqual(partitioned, reasoned);
      assert.notEqual(partitioned, sourceless);
      assert.notEqual(reasoned, sourceless);
    });

    it("treats a missing source and an empty source alike", function () {
      assert.equal(
        server.rdf._statementId("a", "b", "c"),
        server.rdf._statementId("a", "b", "c", "")
      );
    });

    it("distinguishes different triples", function () {
      assert.notEqual(
        server.rdf._statementId("track:report-1", "rdf:type", "track:Sighting", "p"),
        server.rdf._statementId("track:report-2", "rdf:type", "track:Sighting", "p")
      );
    });
  });

  describe("_statementIdForResource", function () {
    const doc = (overrides = {}) => ({
      "@type": ["rdf:Statement"],
      "rdf:subject": "nice:K0865",
      "rdf:predicate": "owl:sameAs",
      "rdf:object": "nice:K0377",
      ...overrides,
    });

    it("agrees with _statementId over the same triple and source", function () {
      assert.equal(
        server.rdf._statementIdForResource(doc({ "dcterms:isPartOf": "nice:nice" })),
        server.rdf._statementId("nice:K0865", "owl:sameAs", "nice:K0377", "nice:nice")
      );
    });

    it("prefers dcterms:isPartOf over bold:provenance as the source", function () {
      const both = server.rdf._statementIdForResource(doc({
        "dcterms:isPartOf": "nice:nice",
        "bold:provenance": "nist:mapping",
      }));
      assert.equal(both, server.rdf._statementId("nice:K0865", "owl:sameAs", "nice:K0377", "nice:nice"));
    });

    it("falls back to bold:provenance when there is no partition", function () {
      assert.equal(
        server.rdf._statementIdForResource(doc({ "bold:provenance": "nist:mapping" })),
        server.rdf._statementId("nice:K0865", "owl:sameAs", "nice:K0377", "nist:mapping")
      );
    });

    it("unwraps single-element arrays so compaction shape does not change the id", function () {
      // ld.compact(..., {ensureArrayProps: true}) can hand back arrays where the
      // reasoner passes bare scalars. Both must hash alike.
      assert.equal(
        server.rdf._statementIdForResource(doc({
          "rdf:subject": ["nice:K0865"],
          "rdf:predicate": ["owl:sameAs"],
          "rdf:object": ["nice:K0377"],
        })),
        server.rdf._statementIdForResource(doc())
      );
    });

    it("unwraps @id and @value objects", function () {
      assert.equal(
        server.rdf._statementIdForResource(doc({
          "rdf:subject": { "@id": "nice:K0865" },
          "rdf:object": { "@value": "nice:K0377" },
        })),
        server.rdf._statementIdForResource(doc())
      );
    });

    it("reads expanded rdf term names too", function () {
      const expanded = {
        "@type": ["rdf:Statement"],
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject": "nice:K0865",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate": "owl:sameAs",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#object": "nice:K0377",
      };
      assert.equal(server.rdf._statementIdForResource(expanded), server.rdf._statementIdForResource(doc()));
    });

    it("returns null for a statement with no complete triple", function () {
      assert.isNull(server.rdf._statementIdForResource({ "@type": ["rdf:Statement"] }));
      assert.isNull(server.rdf._statementIdForResource(doc({ "rdf:object": undefined })));
      assert.isNull(server.rdf._statementIdForResource(doc({ "rdf:object": [] })));
    });

    it("is stable for a multi-valued term regardless of order", function () {
      assert.equal(
        server.rdf._statementIdForResource(doc({ "rdf:object": ["b", "a"] })),
        server.rdf._statementIdForResource(doc({ "rdf:object": ["a", "b"] }))
      );
    });
  });

  describe("createStatementsForFacts", function () {
    const buildStatements = async (extraOpts = {}) => {
      const facts = server.rdf._derivationsToFacts([derivation("report-1")]);
      return server.rdf.createStatementsForFacts(facts, {
        onlyInferred: true,
        metaPropsByPredicate: { "*": { "bold:provenance": "bold:reasonCollection" } },
        ...extraOpts,
      });
    };

    it("mints the same ids when re-run over the same facts", async function () {
      const first = await buildStatements();
      const second = await buildStatements();
      assert.lengthOf(first, 1);
      assert.deepEqual(first.map(s => s._id), second.map(s => s._id));
      assert.match(first[0]._id, /^bold:stmt-[0-9a-f]{16}$/);
    });

    it("gives a statement its subject's dcterms:isPartOf", async function () {
      const [statement] = await buildStatements({
        subjectPartitions: { "track:report-1": "track:track-2025" },
      });
      assert.equal(statement["rdf:subject"], "track:report-1");
      assert.equal(statement["dcterms:isPartOf"], "track:track-2025");
    });

    it("leaves dcterms:isPartOf unset for a subject with no partition", async function () {
      const [statement] = await buildStatements();
      assert.notProperty(statement, "dcterms:isPartOf");
    });

    it("derives a different id once the subject has a partition", async function () {
      const [withPartition] = await buildStatements({
        subjectPartitions: { "track:report-1": "track:track-2025" },
      });
      const [withoutPartition] = await buildStatements();
      // The partition is the id's provenance discriminator, so the two coexist
      // rather than one clobbering the other.
      assert.notEqual(withPartition._id, withoutPartition._id);
    });

    it("is order-independent for an array partition", async function () {
      const [a] = await buildStatements({
        subjectPartitions: { "track:report-1": ["track:track-2025", "track:track-legacy"] },
      });
      const [b] = await buildStatements({
        subjectPartitions: { "track:report-1": ["track:track-legacy", "track:track-2025"] },
      });
      assert.equal(a._id, b._id);
    });
  });

  describe("_persistStatements", function () {
    const statement = (overrides = {}) => ({
      _id: "bold:stmt-0123456789abcdef",
      "@type": ["rdf:Statement"],
      "rdf:subject": "track:report-1",
      "rdf:predicate": "rdf:type",
      "rdf:object": "track:Sighting",
      "dcterms:isPartOf": "track:track-2025",
      "bold:when": "2026-01-01T00:00:00.000Z",
      ...overrides,
    });

    it("writes the statement on first persist", async function () {
      const written = await server.reasoner._persistStatements([statement()]);
      assert.equal(written, 1);
      assert.equal(statementsStore.docs.size, 1);
      const doc = await statementsStore.findOne({ _id: "bold:stmt-0123456789abcdef" });
      assert.equal(doc["dcterms:isPartOf"], "track:track-2025");
      assert.equal(doc["bold:when"], "2026-01-01T00:00:00.000Z");
    });

    it("re-persisting the same statement creates no second document and touches nothing", async function () {
      await server.reasoner._persistStatements([statement()]);
      // A later run would carry a fresh bold:when; $setOnInsert must ignore it.
      const written = await server.reasoner._persistStatements([
        statement({ "bold:when": "2026-06-30T12:00:00.000Z" }),
      ]);
      assert.equal(written, 0, "second write should be a no-op");
      assert.equal(statementsStore.docs.size, 1);
      const doc = await statementsStore.findOne({ _id: "bold:stmt-0123456789abcdef" });
      assert.equal(doc["bold:when"], "2026-01-01T00:00:00.000Z", "first-seen time is stable");
    });

    it("updates a statement whose other fields changed", async function () {
      await server.reasoner._persistStatements([statement()]);
      const written = await server.reasoner._persistStatements([
        statement({ "bold:explanation": "because rdfs9" }),
      ]);
      assert.equal(written, 1);
      assert.equal(statementsStore.docs.size, 1);
      const doc = await statementsStore.findOne({ _id: "bold:stmt-0123456789abcdef" });
      assert.equal(doc["bold:explanation"], "because rdfs9");
    });

    it("derives a deterministic id for a statement that arrives without one", async function () {
      const { _id, ...idless } = statement();
      await server.reasoner._persistStatements([idless]);
      await server.reasoner._persistStatements([idless]);
      assert.equal(statementsStore.docs.size, 1);
      const [doc] = [...statementsStore.docs.values()];
      assert.match(doc._id, /^bold:stmt-[0-9a-f]{16}$/);
      assert.equal(
        doc._id,
        server.rdf._statementId("track:report-1", "rdf:type", "track:Sighting", "track:track-2025")
      );
    });

    it("returns 0 and writes nothing for an empty batch", async function () {
      assert.equal(await server.reasoner._persistStatements([]), 0);
      assert.equal(statementsStore.docs.size, 0);
    });

    it("falls back to per-document upserts when the collection has no bulkWrite", async function () {
      const calls = [];
      server.collections.statements = {
        async updateOne(filter, update, options) {
          calls.push({ filter, update, options });
          return { upsertedCount: 1, modifiedCount: 0 };
        },
      };
      const written = await server.reasoner._persistStatements([statement()]);
      assert.equal(written, 1);
      assert.lengthOf(calls, 1);
      assert.deepEqual(calls[0].filter, { _id: "bold:stmt-0123456789abcdef" });
      assert.isTrue(calls[0].options.upsert);
      assert.property(calls[0].update.$setOnInsert, "bold:when");
      assert.notProperty(calls[0].update.$set, "bold:when");
      assert.notProperty(calls[0].update.$set, "_id");
    });
  });

  describe("reasonCollection", function () {
    let originalFetch;
    let updateCalls;

    beforeEach(function () {
      updateCalls = 0;
      originalFetch = globalThis.fetch;
      // Stand in for HyLAR: healthy, classifies, and answers /update with one
      // inferred derivation per report.
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/update")) {
          updateCalls++;
          return {
            ok: true,
            json: async () => ({
              derivations: { additions: [derivation("report-1"), derivation("report-2")] },
            }),
          };
        }
        return { ok: true, json: async () => ({ derivations: { additions: [] } }) };
      };
    });

    afterEach(function () {
      globalThis.fetch = originalFetch;
    });

    const reasonTrack = () => server.reasoner.reasonCollection("track", {
      selector: { "dcterms:isPartOf": "track:track-2025" },
      onlyUnReasoned: false,
      // Statements are what this test is about; leave the reports alone so the
      // second run sees the same input as the first.
      updateResources: false,
    });

    it("tags its statements with the subject's partition", async function () {
      await reasonTrack();
      const written = [...statementsStore.docs.values()];
      assert.isNotEmpty(written);
      for (const doc of written) {
        assert.equal(doc["dcterms:isPartOf"], "track:track-2025");
        assert.match(doc._id, /^bold:stmt-[0-9a-f]{16}$/);
      }
      // The whole point of the partition tag: one selector clears the partition.
      assert.equal(
        await statementsStore.countDocuments({ "dcterms:isPartOf": "track:track-2025" }),
        written.length
      );
    });

    it("keeps the statement count stable when the same partition is reasoned twice", async function () {
      await reasonTrack();
      const afterFirst = statementsStore.docs.size;
      const whenFirst = [...statementsStore.docs.values()].map(d => d["bold:when"]);
      assert.isAbove(afterFirst, 0);

      await reasonTrack();
      assert.equal(statementsStore.docs.size, afterFirst, "re-reasoning must not duplicate statements");
      assert.deepEqual(
        [...statementsStore.docs.values()].map(d => d["bold:when"]),
        whenFirst,
        "bold:when is first-seen time, unchanged by a re-run"
      );
      assert.isAbove(updateCalls, 1, "the second run really did reason again");
    });
  });

  /**
   * Imported statements get the same content-addressed ids as reasoned ones
   * (IoApi._normalizeAndSaveResource step 5.9), so re-importing a source file —
   * or importing the same assertion from a second source — addresses the same
   * document instead of adding another.
   */
  describe("import", function () {
    let importServer;
    let importStatements;
    let ontologyStore;

    // Shaped like nice.all.full.jsonld: a leading owl:Ontology (which supplies
    // dcterms:isPartOf) followed by statements whose source ids are built from
    // the triple they reify.
    const SOURCE = () => [
      { "@id": "nice:nice", "@type": "owl:Ontology", "rdfs:label": "NICE" },
      {
        "@id": "nice:K0865-K0377",
        "@type": ["rdf:Statement"],
        "rdf:subject": "nice:K0865",
        "rdf:predicate": "owl:sameAs",
        "rdf:object": "nice:K0377",
        "dc:source": "nist:NICE-Framework-2017-to-v1.0.0-Mapping",
      },
    ];

    beforeEach(async function () {
      importStatements = createStatementsStore();
      ontologyStore = createDocStore();
      const contextStore = createDocStore();
      await contextStore.replaceOne({ _id: "@id" }, {
        ...CONTEXT_DOC,
        dc: "http://purl.org/dc/elements/1.1/",
        nice: "https://csrc.nist.gov/NICE/framework/",
      });

      importServer = new OntologizeServer(ontologyStore, contextStore, importStatements);
      await importServer.ready();
    });

    it("replaces the source _id with a content hash", async function () {
      const result = await importServer.io.importData(SOURCE());

      assert.isTrue(result.success);
      assert.equal(result.statementResources, 1);
      assert.equal(result.statementIdsRewritten, 1);

      assert.equal(importStatements.docs.size, 1);
      const [doc] = [...importStatements.docs.values()];
      assert.match(doc._id, /^bold:stmt-[0-9a-f]{16}$/);
      assert.notEqual(doc._id, "nice:K0865-K0377");
      // Human-readable triple is still right there in the document.
      assert.equal(doc["rdf:subject"], "nice:K0865");
      assert.equal(doc["rdf:predicate"], "owl:sameAs");
      assert.equal(doc["rdf:object"], "nice:K0377");
    });

    it("hashes over the partition the import assigned", async function () {
      await importServer.io.importData(SOURCE());
      const [doc] = [...importStatements.docs.values()];

      // Step 5.75 tags the statement with the leading ontology; step 5.9 hashes
      // that value as the provenance discriminator, so the id must match one
      // built from the persisted document.
      assert.include(doc["dcterms:isPartOf"], "nice:nice");
      assert.equal(doc._id, importServer.rdf._statementIdForResource(doc));
    });

    it("re-importing the same source creates no second document", async function () {
      await importServer.io.importData(SOURCE());
      const firstId = [...importStatements.docs.keys()][0];

      const result = await importServer.io.importData(SOURCE());
      assert.equal(importStatements.docs.size, 1, "re-import must not duplicate the statement");
      assert.equal([...importStatements.docs.keys()][0], firstId);
      assert.equal(result.statementIdsRewritten, 1);
    });

    it("gives the same id to the same assertion arriving under a different source id", async function () {
      await importServer.io.importData(SOURCE());
      const firstId = [...importStatements.docs.keys()][0];

      // Same ontology, same triple, different naming convention in the source.
      const renamed = SOURCE();
      renamed[1]["@id"] = "nice:mapping-1729";
      await importServer.io.importData(renamed);

      assert.equal(importStatements.docs.size, 1, "the source id is not part of the identity");
      assert.equal([...importStatements.docs.keys()][0], firstId);
    });

    it("distinguishes statements about different triples", async function () {
      const data = SOURCE();
      data.push({
        "@id": "nice:K0865-K0287",
        "@type": ["rdf:Statement"],
        "rdf:subject": "nice:K0865",
        "rdf:predicate": "owl:sameAs",
        "rdf:object": "nice:K0287",
      });

      const result = await importServer.io.importData(data);
      assert.equal(result.statementResources, 2);
      assert.equal(importStatements.docs.size, 2);
    });

    it("keeps the source _id when the statement carries no complete triple", async function () {
      const data = [
        { "@id": "nice:nice", "@type": "owl:Ontology", "rdfs:label": "NICE" },
        // Typed rdf:Statement, but nothing to content-address it by.
        { "@id": "nice:stmt-incomplete", "@type": ["rdf:Statement"], "rdfs:comment": "placeholder" },
      ];

      const result = await importServer.io.importData(data);
      assert.equal(result.statementResources, 1);
      assert.equal(result.statementIdsRewritten, 0);
      assert.isTrue(importStatements.docs.has("nice:stmt-incomplete"));
    });

    it("leaves non-statement resources' ids alone", async function () {
      const data = [
        { "@id": "nice:nice", "@type": "owl:Ontology", "rdfs:label": "NICE" },
        { "@id": "nice:K0865", "@type": ["owl:Class"], "rdfs:label": "Knowledge 865" },
      ];

      const result = await importServer.io.importData(data);
      assert.equal(result.statementResources, 0);
      assert.equal(result.statementIdsRewritten, 0);
      assert.isTrue(ontologyStore.docs.has("nice:K0865"));
    });

    it("hashes the id after beforeSaveFn, which still sees the source id", async function () {
      const seen = [];
      await importServer.io.importData(SOURCE(), {
        beforeSaveFn: (resource) => {
          seen.push(resource._id);
          return resource;
        },
      });

      assert.include(seen, "nice:K0865-K0377", "beforeSaveFn sees the source's own id");
      const [doc] = [...importStatements.docs.values()];
      assert.match(doc._id, /^bold:stmt-[0-9a-f]{16}$/);
    });

    it("hashes the triple beforeSaveFn actually persisted", async function () {
      await importServer.io.importData(SOURCE(), {
        beforeSaveFn: (resource) => {
          if (resource["rdf:object"]) resource["rdf:object"] = "nice:K9999";
          return resource;
        },
      });

      const [doc] = [...importStatements.docs.values()];
      assert.equal(doc._id, importServer.rdf._statementIdForResource(doc));
      assert.notEqual(
        doc._id,
        importServer.rdf._statementId("nice:K0865", "owl:sameAs", "nice:K0377", ["nice:nice"])
      );
    });
  });
});
