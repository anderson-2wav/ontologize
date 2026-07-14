/**
 * THROWAWAY end-to-end verification of warmReasoner + updateOne against a LIVE HyLAR.
 * Not part of the suite (*.throwaway.js). Run:
 *   cd modules/ontologize
 *   npx mocha tests/warm-verify.throwaway.js --timeout 120000
 *
 * Proves the demo fix: warm HyLAR from the live ontology, then updateOne a class to
 * add a superclass, and confirm the TRANSITIVE superclass is inferred. bfo:entity is
 * only derivable if warm actually loaded the live `bfo:continuant ⊑ bfo:entity` edge
 * into HyLAR (the old archive-restore path would have wiped it).
 *
 * Requires mongod on 127.0.0.1:3201; writes only to a scratch `warm_verify` db.
 * Spawns HyLAR on port 4000.
 */

import { assert } from "chai";
import { MongoClient } from "mongodb";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const MONGO_HOST = process.env.MONGO || "mongodb://127.0.0.1:3201";
const TEST_DB = "warm_verify";
const HYLAR_URL = "http://localhost:4000";

globalThis.Meteor = globalThis.Meteor || { settings: {} };
process.env.APP_DIR = REPO_ROOT;
const { OntologizeServer } = await import("../src/OntologizeServer.js");

describe("warmReasoner + updateOne (throwaway, live HyLAR)", function () {
  this.timeout(120000);
  let client, db, server;

  before(async function () {
    client = new MongoClient(MONGO_HOST);
    await client.connect();
    db = client.db(TEST_DB);
    // Fresh scratch collections
    for (const name of ["ontology", "context", "statements"]) {
      await db.collection(name).deleteMany({});
    }
    // Minimal TBox: bfo:continuant ⊑ bfo:entity, and Foo/Bar where Bar ⊑ Foo.
    // (bfo: prefix resolves via Ontologize.DEFAULT_CONTEXT; no context doc needed.)
    await db.collection("ontology").insertMany([
      { _id: "bfo:entity", "@type": ["owl:Class"], "rdfs:label": "entity" },
      { _id: "bfo:continuant", "@type": ["owl:Class"], "rdfs:subClassOf": ["bfo:entity"] },
      { _id: "bfo:Foo", "@type": ["owl:Class"], "rdfs:label": "Foo" },
      { _id: "bfo:Bar", "@type": ["owl:Class"], "rdfs:subClassOf": ["bfo:Foo"] },
      { _id: "bfo:Baz", "@type": ["owl:Class"], "rdfs:label": "Baz" },
      { _id: "bfo:Qux", "@type": ["owl:Class"], "rdfs:subClassOf": ["bfo:Baz"] }
    ]);

    server = new OntologizeServer(
      db.collection("ontology"),
      db.collection("context"),
      db.collection("statements"),
      { mongoUrl: `${MONGO_HOST}/${TEST_DB}`, hylarUrl: HYLAR_URL, hylarPort: 4000 }
    );
  });

  after(async function () {
    if (server && server.hylarProcess) {
      server.hylarProcess.removeAllListeners("exit");
      server.hylarProcess.kill("SIGTERM");
    }
    if (client) await client.close();
  });

  it("warms from live ontology, then updateOne infers the transitive superclass", async function () {
    // Warm primes HyLAR with the live ontology closure (spawns HyLAR).
    const warm = await server.warmReasoner({});
    assert.equal(warm.resourcesLoaded, 6, "warm should load all 6 ontology resources");

    // Now add bfo:Foo ⊑ bfo:continuant. HyLAR should transitively infer bfo:Foo ⊑ bfo:entity.
    const res = await server.updateOne(
      "bfo:Foo",
      { "rdfs:subClassOf": "bfo:continuant" },
      { collection: "ontology", includeStatements: true }
    );

    const superClasses = [].concat(res.resource["rdfs:subClassOf"] || []);
    console.log("bfo:Foo rdfs:subClassOf after update:", superClasses);

    assert.include(superClasses, "bfo:continuant", "explicit superclass should be present");
    assert.include(
      superClasses,
      "bfo:entity",
      "TRANSITIVE superclass must be inferred — proves warm loaded bfo:continuant ⊑ bfo:entity into HyLAR"
    );

    // And it persisted to Mongo.
    const persisted = await db.collection("ontology").findOne({ _id: "bfo:Foo" });
    const persistedSup = [].concat(persisted["rdfs:subClassOf"] || []);
    assert.include(persistedSup, "bfo:entity", "inferred superclass should be persisted to the ontology collection");

    // Default (single-subject) behavior: bfo:Bar is DERIVED but not persisted.
    const barDefault = await db.collection("ontology").findOne({ _id: "bfo:Bar" });
    const barDefaultSup = [].concat(barDefault["rdfs:subClassOf"] || []);
    assert.notInclude(barDefaultSup, "bfo:continuant", "without persistAllSubjects, bfo:Bar is not persisted");

    // updateOne should also persist inferred rdf:Statements queryable by rdf:subject.
    // This is exactly the mechanism tests/reasoner.app-tests.js "Inference Verification"
    // now relies on (counting statements with rdf:subject === the reasoned resource).
    const stmtCount = await db.collection("statements").countDocuments({ "rdf:subject": "bfo:Foo" });
    console.log("persisted statements with rdf:subject bfo:Foo:", stmtCount);
    assert.isAbove(stmtCount, 0, "updateOne should persist inferred statements queryable by rdf:subject");
  });

  it("persistAllSubjects persists inferences on all affected subjects", async function () {
    // bfo:Qux ⊑ bfo:Baz. Updating bfo:Baz ⊑ bfo:continuant should transitively give
    // bfo:Qux ⊑ {bfo:continuant, bfo:entity}, persisted because persistAllSubjects is set.
    const res = await server.updateOne(
      "bfo:Baz",
      { "rdfs:subClassOf": "bfo:continuant" },
      { collection: "ontology", persistAllSubjects: true, includeStatements: true }
    );
    console.log("affectedSubjects:", res.affectedSubjects);
    assert.include(res.affectedSubjects, "bfo:Qux", "bfo:Qux should be reported as an affected subject");

    const qux = await db.collection("ontology").findOne({ _id: "bfo:Qux" });
    const quxSup = [].concat(qux["rdfs:subClassOf"] || []);
    console.log("bfo:Qux rdfs:subClassOf:", quxSup);
    assert.include(quxSup, "bfo:continuant", "bfo:Qux should inherit bfo:continuant transitively");
    assert.include(quxSup, "bfo:entity", "bfo:Qux should inherit bfo:entity transitively");

    // Inferred statements for the other subject should be persisted too.
    const quxStmts = await db.collection("statements").countDocuments({ "rdf:subject": "bfo:Qux" });
    assert.isAbove(quxStmts, 0, "inferred statements for bfo:Qux should be persisted");
  });
});
