/**
 * THROWAWAY experiment — NOT part of the normal suite.
 *
 * Filename is *.throwaway.js (not *.test.js) so `mocha tests/**\/*.test.js` skips it.
 * Run explicitly:
 *
 *   cd modules/ontologize
 *   npx mocha tests/reasoner-idempotency.throwaway.js --timeout 900000
 *
 * Optional env:
 *   SKIP_RESTORE=1              reuse an existing reasoner_expt db (skip mongorestore)
 *   ARCHIVE=bold.65k.archive    which archive under bold-assets/archives/
 *   LIMIT=500                   only load the first N ontology resources (0 = all)
 *
 * Question being probed (see ontologize-tour-spec.md "Additional problems with
 * reasoner bootstrap"): if we load an ALREADY-reasoned ontology into HyLAR and
 * classify, what comes back as `derivations.additions`?
 *   - echoedExplicit  : HyLAR re-stating an asserted triple (E-facts / already sent)
 *   - alreadyRecorded : an inferred triple we ALREADY have a Statement for (redundant)
 *   - novel           : an inferred triple with NO existing Statement (a surprise —
 *                       either non-idempotent, or an inference BOLD never materialized)
 *
 * Requires: mongod on 127.0.0.1:3201 (the dev mongo — only a throwaway
 * `reasoner_expt` db is written, the real `meteor` db is never touched) and
 * `mongorestore` on PATH. Spawns a HyLAR child process on port 4000.
 */

import { assert } from "chai";
import { MongoClient } from "mongodb";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");           // .../bold-main-2
const MONGO_HOST = "mongodb://127.0.0.1:3201";
const TEST_DB = "reasoner_expt";
const ARCHIVE = process.env.ARCHIVE || "bold.65k.archive";
const ARCHIVE_PATH = path.join(REPO_ROOT, "bold-assets/archives", ARCHIVE);
const HYLAR_URL = "http://localhost:4000";
const LIMIT = parseInt(process.env.LIMIT || "0", 10);
const OUT = path.join(REPO_ROOT, "modules/ontologize/tests/_reasoner-idempotency.out.json");

// --- HyLAR spawn needs a Meteor global (single ref: hylarHeapSize) + APP_DIR ---
globalThis.Meteor = globalThis.Meteor || { settings: {} };
process.env.APP_DIR = REPO_ROOT;

// Imported after the shim so anything reading Meteor at import time is fine.
const { OntologizeServer } = await import("../src/OntologizeServer.js");

const SEP = " |> ";
function tripleKey(s, p, o) {
  return `${s}${SEP}${p}${SEP}${o}`;
}

describe("reasoner idempotency (throwaway)", function () {
  this.timeout(900000);

  let client;
  let db;
  let server;

  before(async function () {
    // 1. Restore ONLY ontology/context/statements, remapped into reasoner_expt.
    if (!process.env.SKIP_RESTORE) {
      assert.isTrue(fs.existsSync(ARCHIVE_PATH), `archive not found: ${ARCHIVE_PATH}`);
      console.log(`Restoring ${ARCHIVE} -> ${TEST_DB} (ontology/context/statements only)...`);
      const args = [
        "--nsInclude=meteor.ontology",
        "--nsInclude=meteor.context",
        "--nsInclude=meteor.statements",
        "--nsFrom=meteor.*",
        "--nsTo=" + TEST_DB + ".*",
        "--drop",
        "--archive=" + ARCHIVE_PATH,
        MONGO_HOST + "/"
      ];
      const r = spawnSync("mongorestore", args, { encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`mongorestore failed (${r.status}): ${r.stderr || r.stdout}`);
      }
      console.log("Restore complete.");
    }

    // 2. Connect the driver; plain driver collections satisfy the read interface
    //    (findOne / find().toArray()) that the OntologizeServer helpers use.
    client = new MongoClient(MONGO_HOST);
    await client.connect();
    db = client.db(TEST_DB);

    server = new OntologizeServer(
      db.collection("ontology"),
      db.collection("context"),
      db.collection("statements"),
      { mongoUrl: `${MONGO_HOST}/${TEST_DB}`, hylarUrl: HYLAR_URL, hylarPort: 4000 }
    );

    // 3. Bring HyLAR up (spawns the child process, waits until ready).
    console.log("Starting / verifying HyLAR...");
    await server.reasoner.checkHylar({ hylarUrl: HYLAR_URL, hylarPort: 4000 });
  });

  after(async function () {
    try { await fetch(`${HYLAR_URL}/classify/off`); } catch { /* ignore */ }
    if (server && server.hylarProcess) {
      server.hylarProcess.removeAllListeners("exit");
      server.hylarProcess.kill("SIGTERM");
    }
    if (client) await client.close();
  });

  it("classifies an already-reasoned ontology and categorizes the additions", async function () {
    const ld = server.ld();
    const context = await server.getContext();
    // Literal objects (booleans, numbers) can appear as triple objects — only
    // compact real string URIs; stringify everything else for the key.
    const compact = (v) => (typeof v === "string" ? ld.compactUri(v, context) : String(v));

    // --- Load the (post-reasoned) ontology resources ---
    let resources = await db.collection("ontology").find({}).toArray();
    if (LIMIT > 0) resources = resources.slice(0, LIMIT);
    console.log(`Loaded ${resources.length} ontology resources`);

    // getTriplesForResources mutates its input — deep clone first.
    const clones = resources.map((r) => structuredClone(r));
    const triples = await server.rdf.getTriplesForResources(clones, {
      blankNodes: false,
      includeStatements: false
    });
    console.log(`Generated ${triples.length} triples`);

    // Set of asserted triples we sent in (compacted), to spot echoed assertions.
    const assertedKeys = new Set(
      triples.map((t) => tripleKey(compact(t.s), compact(t.p), compact(t.o)))
    );

    // Set of triples we ALREADY have inferred Statements for.
    const stmtDocs = await db.collection("statements")
      .find({ "@type": "rdf:Statement" }).toArray();
    const recordedKeys = new Set(
      stmtDocs.map((d) => tripleKey(d["rdf:subject"], d["rdf:predicate"], d["rdf:object"]))
    );
    console.log(`Existing rdf:Statement docs: ${stmtDocs.length}`);

    // --- classify off, bulk insert, classify on ---
    let resp = await fetch(`${HYLAR_URL}/classify/off`);
    assert.isTrue(resp.ok, "classify/off failed");

    const BATCH = 1000;
    for (let i = 0; i < triples.length; i += BATCH) {
      const batch = triples.slice(i, i + BATCH);
      const sparql = await server.rdf.createSparqlInsert(batch);
      resp = await fetch(`${HYLAR_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sparql })
      });
      assert.isTrue(resp.ok, `insert batch ${i / BATCH} failed`);
    }

    resp = await fetch(`${HYLAR_URL}/classify/on`);
    assert.isTrue(resp.ok, "classify/on failed");
    const classifyData = await resp.json();
    const additions = classifyData.derivations?.additions || [];
    console.log(`classify/on returned ${additions.length} additions`);

    // --- categorize ---
    const facts = server.rdf._derivationsToFacts(additions, { blankNodes: false });

    const cats = { echoedExplicit: [], alreadyRecorded: [], novel: [] };
    for (const f of facts) {
      const key = tripleKey(compact(f.subject), compact(f.predicate), compact(f.object));
      if (f.explicit || assertedKeys.has(key)) {
        cats.echoedExplicit.push(key);
      }
      else if (recordedKeys.has(key)) {
        console.log(`${key} already recorded`);
        cats.alreadyRecorded.push(key);
      }
      else {
        cats.novel.push(key);
      }
    }

    const summary = {
      archive: ARCHIVE,
      ontologyResources: resources.length,
      triplesLoaded: triples.length,
      existingInferredStatements: stmtDocs.length,
      additionsTotal: facts.length,
      echoedExplicit: cats.echoedExplicit.length,
      alreadyRecorded: cats.alreadyRecorded.length,
      novel: cats.novel.length
    };

    console.log("\n===== IDEMPOTENCY SUMMARY =====");
    console.table(summary);
    console.log("Sample NOVEL additions (up to 25):");
    for (const k of cats.novel.slice(0, 25)) console.log("  " + k);

    fs.writeFileSync(OUT, JSON.stringify({
      summary,
      novel: cats.novel,
      alreadyRecordedSample: cats.alreadyRecorded.slice(0, 100)
    }, null, 2));
    console.log(`\nFull dump written to ${OUT}`);

    // Not an assertion of correctness — this is an observational experiment.
    assert.isAtLeast(summary.triplesLoaded, 1, "expected to load some triples");
  });
});
