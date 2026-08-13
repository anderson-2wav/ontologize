/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Tests for the window provider (bounds lookup + TTL cache) and the collection
 * wrapper that composes the window into every read.
 */

import { assert } from "chai";
import { createWindowProvider, windowCollection } from "../src/geo/windowedCollection.js";

const ZONE = "America/Chicago";
const NOW = Date.parse("2025-06-10T17:00:00Z");
const CUTOFF = Date.parse("2025-05-11T05:00:00Z");   // midnight, 30 days before

/** An animal collection that records how many times, and how, it was read. */
function animalsStub(docs = []) {
  const stub = {
    reads: 0,
    selectors: [],
    options: [],
    find(selector, options) {
      stub.reads++;
      stub.selectors.push(selector);
      stub.options.push(options);
      return { toArray: async () => docs };
    },
  };
  return stub;
}

/** A data collection that records the selector/pipeline it was handed. */
function dataStub() {
  const stub = {
    selectors: [],
    pipelines: [],
    find(selector) { stub.selectors.push(selector); return { toArray: async () => [] }; },
    findOne(selector) { stub.selectors.push(selector); return Promise.resolve(null); },
    countDocuments(selector) { stub.selectors.push(selector); return Promise.resolve(0); },
    distinct(field, selector) { stub.selectors.push(selector); return Promise.resolve([]); },
    aggregate(pipeline) { stub.pipelines.push(pipeline); return { toArray: async () => [] }; },
    estimatedDocumentCount() { return Promise.resolve(999); },
    createIndex() { return Promise.resolve("ok"); },
  };
  return stub;
}

function providerFor(animals, opts = {}) {
  return createWindowProvider({
    animalCollection: animals,
    timeZone: ZONE,
    delayDays: 30,
    nowFn: () => NOW,
    ttlMs: 60000,
    ...opts,
  });
}

describe("createWindowProvider", function() {
  it("builds a clause from the delay and the individuals' bounds", async function() {
    const animals = animalsStub([{ _id: "track:animal-MA04", "bold:publicDataStart": "2025-02-01" }]);
    const clause = await providerFor(animals).clause();

    assert.deepEqual(clause.$and[0], { _whenMs: { $lte: CUTOFF } });
    assert.deepEqual(clause.$and[1].$or[1], {
      "bold:animal": "track:animal-MA04",
      _whenMs: { $gte: Date.parse("2025-02-01T06:00:00Z") },
    });
  });

  // Only the handful of individuals that carry a bound, projected to the three
  // fields needed — not the whole animal collection on every request.
  it("reads only the individuals carrying a bound, projected", async function() {
    const animals = animalsStub([]);
    await providerFor(animals).clause();

    assert.deepEqual(animals.selectors[0], {
      $or: [
        { "bold:publicDataStart": { $exists: true } },
        { "bold:publicDataEnd": { $exists: true } },
      ],
    });
    assert.deepEqual(animals.options[0], {
      projection: { _id: 1, "bold:publicDataStart": 1, "bold:publicDataEnd": 1 },
    });
  });

  it("reuses the cached bounds within the TTL rather than re-reading", async function() {
    const animals = animalsStub([]);
    const provider = providerFor(animals);

    await provider.clause();
    await provider.clause();
    await provider.clause();

    assert.equal(animals.reads, 1, "three calls, one read");
  });

  it("re-reads once the TTL has elapsed", async function() {
    const animals = animalsStub([]);
    let clock = NOW;
    const provider = providerFor(animals, { nowFn: () => clock, ttlMs: 1000 });

    await provider.clause();
    clock += 1500;
    await provider.clause();

    assert.equal(animals.reads, 2);
  });

  // WILD writes bounds straight to Mongo without going through this app, so
  // there is no invalidation signal — the TTL is the whole strategy.
  it("picks up an edited bound after the TTL", async function() {
    const docs = [];
    const animals = animalsStub(docs);
    let clock = NOW;
    const provider = providerFor(animals, { nowFn: () => clock, ttlMs: 1000 });

    const before = await provider.clause();
    assert.notProperty(before, "$and", "no bounds yet, so only the delay clause");

    docs.push({ _id: "a:1", "bold:publicDataStart": "2025-02-01" });
    clock += 1500;
    const after = await provider.clause();
    assert.property(after, "$and");
  });

  // THE security property: a failure must never degrade to "no window".
  it("throws rather than returning an unwindowed clause when the read fails", async function() {
    const animals = { find() { throw new Error("mongo is down"); } };
    try {
      await providerFor(animals).clause();
      assert.fail("expected a throw");
    }
    catch (err) {
      assert.match(err.message, /mongo is down/);
    }
  });

  it("does not cache a failure", async function() {
    let failing = true;
    const animals = {
      reads: 0,
      find() {
        animals.reads++;
        if (failing) throw new Error("transient");
        return { toArray: async () => [] };
      },
    };
    const provider = providerFor(animals);

    try { await provider.clause(); } catch { /* expected */ }
    failing = false;
    await provider.clause();

    assert.equal(animals.reads, 2, "the failed attempt must not have been cached");
  });

  it("omits the delay clause entirely when the delay is zero", async function() {
    const animals = animalsStub([]);
    const clause = await providerFor(animals, { delayDays: 0 }).clause();
    assert.isNull(clause);
  });
});

describe("windowCollection", function() {
  const CLAUSE = { _whenMs: { $lte: CUTOFF } };
  const staticProvider = { clause: async () => CLAUSE };

  it("composes the window into find without dropping the caller's selector", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.find({ "@type": "track:CollarReport" }).toArray();

    assert.deepEqual(data.selectors[0], {
      $and: [{ "@type": "track:CollarReport" }, CLAUSE],
    });
  });

  it("composes into findOne", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.findOne({ _id: "x" });

    assert.deepEqual(data.selectors[0], { $and: [{ _id: "x" }, CLAUSE] });
  });

  it("composes into countDocuments, so counts match what is visible", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.countDocuments({ "bold:animal": "a:1" });

    assert.deepEqual(data.selectors[0], { $and: [{ "bold:animal": "a:1" }, CLAUSE] });
  });

  it("composes into distinct", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.distinct("bold:animal", {});

    assert.deepEqual(data.selectors[0], CLAUSE);
  });

  it("composes into an aggregation's leading $match", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.aggregate([{ $match: { a: 1 } }, { $group: { _id: "$b" } }]).toArray();

    assert.deepEqual(data.pipelines[0][0], { $match: { $and: [{ a: 1 }, CLAUSE] } });
    assert.deepEqual(data.pipelines[0][1], { $group: { _id: "$b" } });
  });

  it("prepends a $match when the pipeline does not start with one", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.aggregate([{ $sort: { _whenMs: -1 } }]).toArray();

    assert.deepEqual(data.pipelines[0][0], { $match: CLAUSE });
    assert.deepEqual(data.pipelines[0][1], { $sort: { _whenMs: -1 } });
    assert.lengthOf(data.pipelines[0], 2);
  });

  it("handles an empty pipeline", async function() {
    const data = dataStub();
    const col = await windowCollection(data, staticProvider);
    await col.aggregate([]).toArray();

    assert.deepEqual(data.pipelines[0], [{ $match: CLAUSE }]);
  });

  // It takes no filter, so it cannot be windowed — and silently reporting the
  // true total would leak exactly the count the window exists to reduce.
  it("refuses estimatedDocumentCount rather than answering unwindowed", async function() {
    const col = await windowCollection(dataStub(), staticProvider);
    try {
      await col.estimatedDocumentCount();
      assert.fail("expected a throw");
    }
    catch (err) {
      assert.match(err.message, /countDocuments/);
    }
  });

  it("passes non-read methods through untouched", async function() {
    const col = await windowCollection(dataStub(), staticProvider);
    assert.equal(await col.createIndex({ a: 1 }), "ok");
  });

  it("is a pass-through when the provider yields no clause", async function() {
    const data = dataStub();
    const col = await windowCollection(data, { clause: async () => null });
    await col.find({ a: 1 }).toArray();

    assert.deepEqual(data.selectors[0], { a: 1 });
  });
});
