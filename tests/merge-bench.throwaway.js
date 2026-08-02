/**
 * THROWAWAY benchmark — NOT part of the normal suite.
 *
 * A/B for the `_mergeAndUpdateResources` bulk rewrite. Runs the SAME
 * `reasonCollection` pass twice against identical inputs, changing only that one
 * method, and prints the `stageMs` breakdown side by side.
 *
 * Filename is *.throwaway.js (not *.test.js) so `mocha tests/**\/*.test.js` skips it.
 * Run explicitly:
 *
 *   cd modules/ontologize
 *   npx mocha tests/merge-bench.throwaway.js --timeout 3600000
 *
 * Env:
 *   BENCH_MONGO=mongodb://127.0.0.1:3299   throwaway mongod (NOT the dev mongo)
 *   BENCH_DB=merge_bench                   db name, dropped and re-restored per run
 *   BENCH_ARCHIVE=track.all.archive        archive under bold-assets/archives/
 *   BENCH_COLLECTION=animal                collection to reason
 *   BENCH_PORT=4001                        HyLAR port (avoid the app's 4000)
 *   BENCH_VARIANTS=bulk,perResource        which arms to run, in order
 *
 * Fairness requirements, each of which is a real confound if skipped:
 *   - The db is restored from the archive before EVERY arm. Reasoning writes
 *     `bold:reasoned` and merges inferences into the resources, so arm 2 would
 *     otherwise see already-reasoned inputs.
 *   - HyLAR is killed and respawned before EVERY arm. Its store is cumulative;
 *     a second arm against a warm store returns no derivations at all, which
 *     would show the merge stage as free rather than as fast.
 *   - `onlyUnReasoned: false` so the selection is the whole collection and does
 *     not depend on what a previous arm wrote.
 *
 * Only the throwaway db is written. The dev mongo is never contacted.
 */

import { MongoClient } from "mongodb";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const MONGO_HOST = process.env.BENCH_MONGO || "mongodb://127.0.0.1:3299";
const BENCH_DB = process.env.BENCH_DB || "merge_bench";
const ARCHIVE = process.env.BENCH_ARCHIVE || "track.all.archive";
const ARCHIVE_PATH = path.join(REPO_ROOT, "bold-assets/archives", ARCHIVE);
const COLLECTION = process.env.BENCH_COLLECTION || "animal";
const HYLAR_PORT = parseInt(process.env.BENCH_PORT || "4001", 10);
const HYLAR_URL = `http://localhost:${HYLAR_PORT}`;
const VARIANTS = (process.env.BENCH_VARIANTS || "bulk,perResource").split(",");
const OUT = path.join(__dirname, "_merge-bench.out.json");

// Guard: refuse to run against the dev mongo. The whole db gets dropped.
if (/:3201\b/.test(MONGO_HOST) || /:27017\b/.test(MONGO_HOST)) {
  throw new Error(`refusing to run against ${MONGO_HOST} — this benchmark drops its db`);
}

globalThis.Meteor = globalThis.Meteor || { settings: {} };
process.env.APP_DIR = REPO_ROOT;

const { OntologizeServer } = await import("../src/OntologizeServer.js");

/**
 * The pre-optimization implementation, verbatim from the commit before the
 * rewrite: one findOne and one write per resource, awaited in series. Installed
 * on the instance for the "perResource" arm so both arms share every other line
 * of the pass, including the timing instrumentation.
 */
async function legacyMergeAndUpdateResources(assembledResources, collection, opts = {}) {
  const written = [];
  const includeBlankNodes = opts.includeBlankNodes !== false;

  for (const [resourceId, assembledResource] of Object.entries(assembledResources)) {
    if (!includeBlankNodes && resourceId.startsWith("_:")) {
      continue;
    }

    let targetCollection = collection;
    if (!opts.singleCollection) {
      const resolved = await this.ontologize.getCollectionForResource(
        { _id: resourceId, ...assembledResource }
      );
      if (resolved) {
        targetCollection = resolved.collection;
      }
    }

    const existing = await targetCollection.findOne({ _id: resourceId });

    if (existing) {
      const merged = await this.ontologize.mergeResources([existing, assembledResource], {
        mergeArrays: true
      });
      merged["bold:reasoned"] = new Date().toISOString();
      await targetCollection.replaceOne({ _id: resourceId }, merged, { upsert: false });
      written.push(resourceId);
    }
    else {
      if (opts.updateOnly) {
        continue;
      }
      const newResource = { ...assembledResource, _id: resourceId, "bold:reasoned": new Date().toISOString() };
      await targetCollection.insertOne(newResource);
      written.push(resourceId);
    }
  }

  return written;
}

/**
 * The bulk implementation with sub-timers, to answer "the merge stage is the
 * cost — but which part of it?". Splits into collection resolution, the chunk
 * read, the JSON-LD merge (pure CPU), and the write.
 */
const subMs = { resolve: 0, read: 0, mergeCpu: 0, write: 0 };

async function profiledMergeAndUpdateResources(assembledResources, collection, opts = {}) {
  const written = [];
  const includeBlankNodes = opts.includeBlankNodes !== false;
  const CHUNK = 100;
  const t = async (k, fn) => {
    const t0 = performance.now();
    try { return await fn(); }
    finally { subMs[k] += performance.now() - t0; }
  };

  const groups = new Map();
  for (const [resourceId, assembledResource] of Object.entries(assembledResources)) {
    if (!includeBlankNodes && resourceId.startsWith("_:")) continue;

    let targetCollection = collection;
    if (!opts.singleCollection) {
      const resolved = await t("resolve", () => this.ontologize.getCollectionForResource(
        { _id: resourceId, ...assembledResource }
      ));
      if (resolved) targetCollection = resolved.collection;
    }

    if (!groups.has(targetCollection)) groups.set(targetCollection, []);
    groups.get(targetCollection).push({ resourceId, assembledResource });
  }

  for (const [targetCollection, items] of groups) {
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, Math.min(i + CHUNK, items.length));

      const existingById = new Map();
      const ids = chunk.map((c) => c.resourceId);
      const docs = await t("read", () => targetCollection.find({ _id: { $in: ids } }).toArray());
      for (const doc of docs) existingById.set(doc._id, doc);

      const ops = [];
      const opIds = [];
      for (const { resourceId, assembledResource } of chunk) {
        const existing = existingById.get(resourceId);
        if (existing) {
          const merged = await t("mergeCpu", () => this.ontologize.mergeResources(
            [existing, assembledResource], { mergeArrays: true }
          ));
          merged["bold:reasoned"] = new Date().toISOString();
          ops.push({ replaceOne: { filter: { _id: resourceId }, replacement: merged, upsert: false } });
          opIds.push(resourceId);
        }
        else {
          if (opts.updateOnly) continue;
          const newResource = { ...assembledResource, _id: resourceId, "bold:reasoned": new Date().toISOString() };
          ops.push({ insertOne: { document: newResource } });
          opIds.push(resourceId);
        }
      }

      if (ops.length === 0) continue;
      await t("write", () => targetCollection.bulkWrite(ops, { ordered: false }));
      written.push(...opIds);
    }
  }

  return written;
}

/**
 * Instruments the three awaited calls inside `Ontologize.mergeResources` rather
 * than reimplementing it, so what gets measured is the real code path. Wraps the
 * memoized LD instance and the schema/context helpers in place.
 */
const innerMs = { ldCompact: 0, isArrayProperty: 0, getContext: 0 };
let innerCounts = { ldCompact: 0, isArrayProperty: 0, getContext: 0 };

function instrumentMergeInternals(server) {
  for (const k of Object.keys(innerMs)) innerMs[k] = 0;
  innerCounts = { ldCompact: 0, isArrayProperty: 0, getContext: 0 };

  const wrap = (obj, method, key) => {
    const orig = obj[method].bind(obj);
    obj[method] = async (...a) => {
      const t0 = performance.now();
      try { return await orig(...a); }
      finally { innerMs[key] += performance.now() - t0; innerCounts[key] += 1; }
    };
  };

  wrap(server._ld, "compact", "ldCompact");
  wrap(server.schema, "isArrayProperty", "isArrayProperty");
  wrap(server, "getContext", "getContext");
}

/**
 * Content fingerprint of everything a pass writes, so two arms can be compared
 * document-by-document and not just by count. `bold:reasoned` is stamped with
 * wall-clock time and so differs between arms by construction — it is dropped
 * rather than allowed to mask a real difference.
 */
const WRITTEN_COLLECTIONS = ["animal", "species", "abox", "ontology", "statements"];

// Stamped with wall-clock time on every write, so they differ between two runs
// of the SAME code. Verified by running one arm against itself: these are the
// only keys that move.
const VOLATILE_KEYS = new Set(["bold:reasoned", "bold:when"]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((k) => !VOLATILE_KEYS.has(k))
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function snapshot(db) {
  const out = {};
  for (const name of WRITTEN_COLLECTIONS) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = new Map(docs.map((d) => [d._id, d]));
  }
  return out;
}

/**
 * Reports WHICH keys differ, not just that documents do. A count alone cannot
 * distinguish "the merge changed the data" from "a timestamp moved".
 */
function diffSnapshots(a, b) {
  const diffs = [];
  for (const name of WRITTEN_COLLECTIONS) {
    const ma = a[name] || new Map();
    const mb = b[name] || new Map();
    const onlyA = [...ma.keys()].filter((k) => !mb.has(k));
    const onlyB = [...mb.keys()].filter((k) => !ma.has(k));

    const keyCounts = new Map();
    let mismatched = 0;
    let sample = null;
    for (const [id, da] of ma) {
      const db_ = mb.get(id);
      if (!db_) continue;
      const keys = new Set([...Object.keys(da), ...Object.keys(db_)]);
      const bad = [];
      for (const k of keys) {
        if (VOLATILE_KEYS.has(k)) continue;
        if (stableStringify(da[k]) !== stableStringify(db_[k])) bad.push(k);
      }
      if (bad.length) {
        mismatched += 1;
        for (const k of bad) keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
        if (!sample) sample = { id, k: bad[0], a: da[bad[0]], b: db_[bad[0]] };
      }
    }

    if (onlyA.length || onlyB.length || mismatched) {
      let msg = `${name}: ${mismatched}/${ma.size} docs differ`;
      if (onlyA.length) msg += `, ${onlyA.length} only in A (e.g. ${onlyA[0]})`;
      if (onlyB.length) msg += `, ${onlyB.length} only in B (e.g. ${onlyB[0]})`;
      const byKey = [...keyCounts.entries()].sort((x, y) => y[1] - x[1])
        .map(([k, n]) => `${k}(${n})`).join(" ");
      if (byKey) msg += `\n      differing keys: ${byKey}`;
      if (sample) {
        msg += `\n      e.g. ${sample.id} "${sample.k}":` +
          `\n        A: ${JSON.stringify(sample.a).slice(0, 300)}` +
          `\n        B: ${JSON.stringify(sample.b).slice(0, 300)}`;
      }
      diffs.push(msg);
    }
  }
  return diffs;
}

function restoreDb() {
  const r = spawnSync("mongorestore", [
    "--nsFrom=meteor.*",
    "--nsTo=" + BENCH_DB + ".*",
    "--drop",
    "--quiet",
    "--archive=" + ARCHIVE_PATH,
    MONGO_HOST + "/"
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`mongorestore failed (${r.status}): ${r.stderr || r.stdout}`);
  }
}

async function killHylar(server) {
  if (server && server.hylarProcess) {
    server.hylarProcess.removeAllListeners("exit");
    server.hylarProcess.kill("SIGTERM");
    server.hylarProcess = null;
  }
  // Wait for the port to actually free up; the next arm's spawn checks it and
  // would happily reuse a dying process's socket.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${HYLAR_URL}/`, { signal: AbortSignal.timeout(500) });
      if (!res.ok) break;
    }
    catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("merge bulk-vs-per-resource benchmark (throwaway)", function () {
  this.timeout(3600000);

  let client;
  const results = {};
  const snapshots = {};

  before(async function () {
    if (!fs.existsSync(ARCHIVE_PATH)) {
      throw new Error(`archive not found: ${ARCHIVE_PATH}`);
    }
    client = new MongoClient(MONGO_HOST);
    await client.connect();
  });

  after(async function () {
    if (client) await client.close();

    const names = Object.keys(results);
    if (names.length === 0) return;

    console.log(`\n===== MERGE BENCHMARK: ${COLLECTION} from ${ARCHIVE} =====`);
    const stages = [...new Set(names.flatMap((n) => Object.keys(results[n].stageMs)))];
    const fmt = (ms) => (ms / 1000).toFixed(2).padStart(10);
    console.log("stage".padEnd(20) + names.map((n) => n.padStart(10)).join("") + "     delta");
    for (const stage of stages) {
      const vals = names.map((n) => results[n].stageMs[stage] || 0);
      let delta = "";
      if (vals.length === 2 && vals[1] > 0) {
        const speedup = vals[1] / vals[0];
        delta = `  ${speedup.toFixed(2)}x`;
      }
      console.log(stage.padEnd(20) + vals.map(fmt).join("") + delta);
    }
    for (const n of names) {
      const r = results[n];
      console.log(`\n${n}: ${r.resourcesLoaded} resources in, ${r.factsInferred} facts, ` +
        `${r.statementsCreated} statements, ${r.resourcesUpdated} resources written, ` +
        `total ${(r.duration / 1000).toFixed(1)} s`);
    }

    if (names.length === 2 && snapshots[names[0]] && snapshots[names[1]]) {
      const diffs = diffSnapshots(snapshots[names[0]], snapshots[names[1]]);
      console.log(`\nwritten-document equivalence, ${names[0]} vs ${names[1]}:`);
      if (diffs.length === 0) {
        console.log("  IDENTICAL across all written collections");
      }
      else {
        console.log("  DIFFERENCES FOUND:");
        for (const d of diffs) console.log("    " + d);
      }
    }

    fs.writeFileSync(OUT, JSON.stringify({
      archive: ARCHIVE, collection: COLLECTION, results
    }, null, 2));
    console.log(`\nWritten to ${OUT}`);
  });

  // Arms are keyed by position so the same variant can be run twice as a
  // control for run-to-run nondeterminism.
  VARIANTS.forEach((variant, armIdx) => {
    const arm = VARIANTS.filter((v) => v === variant).length > 1
      ? `${variant}#${armIdx + 1}` : variant;
    it(`reasons "${COLLECTION}" with the ${arm} merge`, async function () {
      let server;
      try {
        console.log(`\n--- [${variant}] restoring ${BENCH_DB} from ${ARCHIVE} ---`);
        restoreDb();

        const db = client.db(BENCH_DB);
        server = new OntologizeServer(
          db.collection("ontology"),
          db.collection("context"),
          db.collection("statements"),
          {
            mongoUrl: `${MONGO_HOST}/${BENCH_DB}`,
            hylarUrl: HYLAR_URL,
            hylarPort: HYLAR_PORT,
            // Mirrors settings.json — collection routing is what
            // getCollectionForResource resolves against, so it has to match the
            // app or the two arms would be merging into different places.
            typeCollections: {
              "bold:Species": "species",
              "bold:Animal": "animal",
              "orju:Species": "species",
              "orju:Bird": "animal",
              "*": "abox"
            },
            collections: Object.fromEntries(
              ["animal", "species", "abox", "track", "orju", "demo", "ngss", "links"]
                .map((name) => [name, db.collection(name)])
            )
          }
        );

        if (variant === "perResource") {
          server.reasoner._mergeAndUpdateResources = legacyMergeAndUpdateResources;
        }
        if (variant === "bulkProfiled") {
          for (const k of Object.keys(subMs)) subMs[k] = 0;
          server.reasoner._mergeAndUpdateResources = profiledMergeAndUpdateResources;
        }
        // Re-enables the pre-compaction arrify pass that `preEnsureArrayProps`
        // now leaves off, so its effect on real written documents can be diffed
        // against the default. Done here rather than by an option on the
        // reasoner so production code carries no benchmark switch.
        // Restores the pre-batching shape of assembleFactsIntoResources: one
        // ld.compact per resource, all launched together via Promise.all. Built
        // on the real method with compact:false so only the compaction step
        // differs from the version being measured.
        if (variant === "assembleLegacy") {
          const rdf = server.rdf;
          const origAssemble = rdf.assembleFactsIntoResources.bind(rdf);
          rdf.assembleFactsIntoResources = async (facts, o = {}) => {
            const resources = await origAssemble(facts, { ...o, compact: false });
            if (o.compact === false) return resources;
            const ld = rdf.ld();
            const ctx = o.context || await server.getContext();
            const compacted = await Promise.all(Object.values(resources).map((r) =>
              ld.compact(r, ctx, {
                showContext: false, proxy: false,
                ensureArrayProps: true, ensureSafeKeys: true
              })));
            const out = {};
            for (const r of compacted) out[r._id || r["@id"]] = r;
            return out;
          };
        }
        // Drops the SECOND compaction: both inputs to the merge are already
        // compacted (the existing doc from Mongo, the assembled one by
        // assembleFactsIntoResources), so the question is whether re-compacting
        // the union of two compacted documents changes it.
        if (variant === "noMergeCompact") {
          const orig = server.mergeResourcesBatch.bind(server);
          server.mergeResourcesBatch = (groups, o = {}) =>
            orig(groups, { ...o, compact: false });
        }
        // Drops the second compaction but keeps the one effect it was observed
        // to have on real data: @type ordered most-specific-first. That ordering
        // is not cosmetic — getCollectionForResource routes on the FIRST @type
        // that matches, so losing it silently reroutes resources.
        if (variant === "sortOnly") {
          const orig = server.mergeResourcesBatch.bind(server);
          server.mergeResourcesBatch = async (groups, o = {}) => {
            const merged = await orig(groups, { ...o, compact: false });
            for (const r of merged) {
              if (Array.isArray(r["@type"]) && r["@type"].length > 1) {
                r["@type"] = await server.schema.sortTypesFn(r["@type"], { context: o.context });
              }
            }
            return merged;
          };
        }
        if (variant === "prePassOn") {
          const orig = server.mergeResourcesBatch.bind(server);
          server.mergeResourcesBatch = (groups, o = {}) =>
            orig(groups, { ...o, preEnsureArrayProps: true });
        }

        console.log(`--- [${variant}] starting HyLAR on ${HYLAR_PORT} ---`);
        await server.reasoner.checkHylar({ hylarUrl: HYLAR_URL, hylarPort: HYLAR_PORT });

        // After ready(): _ld only exists once the context has loaded.
        if (variant === "bulkInner") {
          await server.ready();
          instrumentMergeInternals(server);
        }

        const result = await server.reasoner.reasonCollection(COLLECTION, {
          onlyUnReasoned: false,
          hylarUrl: HYLAR_URL,
          hylarPort: HYLAR_PORT
        });

        results[arm] = result;
        snapshots[arm] = await snapshot(db);
        console.log(`--- [${arm}] done in ${(result.duration / 1000).toFixed(1)} s ---`);
        if (variant === "bulkInner") {
          results[arm].innerMs = { ...innerMs };
          console.log("    mergeResources internals:");
          for (const [k, ms] of Object.entries(innerMs).sort((a, b) => b[1] - a[1])) {
            console.log(`      ${k.padEnd(16)} ${(ms / 1000).toFixed(2).padStart(8)} s  ` +
              `over ${String(innerCounts[k]).padStart(7)} calls  ` +
              `${(innerCounts[k] ? ms / innerCounts[k] : 0).toFixed(3)} ms/call`);
          }
        }
        if (variant === "bulkProfiled") {
          results[arm].subMs = { ...subMs };
          const total = Object.values(subMs).reduce((a, b) => a + b, 0);
          console.log("    merge-stage split:");
          for (const [k, ms] of Object.entries(subMs).sort((a, b) => b[1] - a[1])) {
            console.log(`      ${k.padEnd(10)} ${(ms / 1000).toFixed(2).padStart(8)} s  ` +
              `${(total ? 100 * ms / total : 0).toFixed(1).padStart(5)}%`);
          }
        }
      }
      finally {
        await killHylar(server);
      }
    });
  });
});
