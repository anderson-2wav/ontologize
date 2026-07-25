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

  describe("createStatementsForFacts", function () {
    const buildStatements = async (extraOpts = {}) => {
      const facts = server.rdf._derivationsToFacts([derivation("report-1")]);
      return server.rdf.createStatementsForFacts(facts, {
        onlyInferred: true,
        metaPropsByPredicate: { "*": { "bold:createdBy": "bold:reasonCollection" } },
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
});
