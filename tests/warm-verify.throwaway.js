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
const MONGO_HOST = "mongodb://127.0.0.1:3201";
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
      { _id: "bfo:Bar", "@type": ["owl:Class"], "rdfs:subClassOf": ["bfo:Foo"] }
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
    assert.equal(warm.resourcesLoaded, 4, "warm should load all 4 ontology resources");

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
  });
});
