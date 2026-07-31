/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * Tests for the background reasoning runner on ontologizeServer.reasoner.
 *
 * Run: meteor npm run test-ontologize
 */

import { assert } from "chai";
import { ReasonerApi } from "../src/api/server/ReasonerApi.js";

/** A collection stub counting only what the runner asks of it. */
function fakeCollection(docs = []) {
  return {
    docs,
    countDocuments: async (selector = {}) => {
      if (selector["bold:reasoned"]?.$exists === true) {
        return docs.filter(d => d["bold:reasoned"] !== undefined).length;
      }
      if (selector["bold:reasoned"]?.$exists === false) {
        return docs.filter(d => d["bold:reasoned"] === undefined).length;
      }
      return docs.length;
    },
    find: () => ({
      limit: () => ({
        toArray: async () => docs.filter(d => d["bold:reasoned"] === undefined),
      }),
    }),
  };
}

/**
 * A ReasonerApi over a stub owner. `collections` is given as an array of names
 * so registration order is explicit and readable in each test.
 */
function makeApi({ names = [], opts = {}, docsByName = {} } = {}) {
  const collections = {};
  for (const name of names) collections[name] = fakeCollection(docsByName[name] || []);
  return new ReasonerApi({ collections, opts });
}

describe("ReasonerApi reasoned-collection selection", function () {

  it("excludes ontology, context and statements", function () {
    const api = makeApi({ names: ["ontology", "context", "statements", "species", "track"] });
    assert.deepEqual(api._reasonedCollectionNames(), ["species", "track"]);
  });

  it("uses registration order when no hint is set", function () {
    const api = makeApi({ names: ["ontology", "context", "statements", "animal", "species", "orju", "track"] });
    assert.deepEqual(api._reasonedCollectionNames(), ["animal", "species", "orju", "track"]);
  });

  it("front-loads the names in reasonOrder, remainder in registration order", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "animal", "species", "orju", "track", "ngss"],
      opts: { reasonOrder: ["species", "animal"] },
    });
    assert.deepEqual(api._reasonedCollectionNames(), ["species", "animal", "orju", "track", "ngss"]);
  });

  // The property that makes a third entry unnecessary: track cannot precede
  // animal once animal is front-loaded, whatever the registration order.
  it("puts track after animal for any registration order of the remainder", function () {
    for (const rest of [["track", "orju"], ["orju", "track"], ["track"]]) {
      const api = makeApi({
        names: ["ontology", "context", "statements", ...rest, "animal", "species"],
        opts: { reasonOrder: ["species", "animal"] },
      });
      const order = api._reasonedCollectionNames();
      assert.isBelow(order.indexOf("animal"), order.indexOf("track"),
        `animal must precede track for registration ${JSON.stringify(rest)}`);
    }
  });

  it("ignores a reasonOrder name that is not a reasoned collection", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "species", "track"],
      opts: { reasonOrder: ["species", "nope", "ontology"] },
    });
    assert.deepEqual(api._reasonedCollectionNames(), ["species", "track"]);
  });

  it("still reasons a registered collection missing from reasonOrder", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "species", "demo"],
      opts: { reasonOrder: ["species"] },
    });
    assert.include(api._reasonedCollectionNames(), "demo");
  });

  it("tolerates a non-array reasonOrder", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "species"],
      opts: { reasonOrder: "species" },
    });
    assert.deepEqual(api._reasonedCollectionNames(), ["species"]);
  });
});

/** Resolve once the runner has released the single-flight guard. */
async function settle(api, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (!api.isReasoningRunning()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("reasoning did not settle");
}

/** makeApi + a recording reasonCollection stub. */
function makeRunnableApi({ names, opts = {}, docsByName = {}, onReason } = {}) {
  const api = makeApi({ names, opts, docsByName });
  api.calls = [];
  api.reasonCollection = async (name, callOpts) => {
    api.calls.push({ name, selector: callOpts.selector });
    if (onReason) await onReason(name, callOpts);
    return { resourcesLoaded: 1, statementsCreated: 2, factsInferred: 3 };
  };
  return api;
}

describe("ReasonerApi background runner", function () {

  it("reasons every reasoned collection in order, and settles", async function () {
    const api = makeRunnableApi({
      names: ["ontology", "context", "statements", "animal", "species", "track"],
      opts: { reasonOrder: ["species", "animal"] },
    });

    const started = api.startReasoning();
    assert.deepEqual(started, { started: true, queued: false, running: true, scope: null });

    await settle(api);
    assert.deepEqual(api.calls.map(c => c.name), ["species", "animal", "track"]);
  });

  it("passes a partition selector when scoped, and an empty one when not", async function () {
    const api = makeRunnableApi({ names: ["ontology", "context", "statements", "track"] });

    api.startReasoning({ scope: "track:track-2025" });
    await settle(api);
    assert.deepEqual(api.calls[0].selector, { "dcterms:isPartOf": "track:track-2025" });

    api.calls = [];
    api.startReasoning();
    await settle(api);
    assert.deepEqual(api.calls[0].selector, {});
  });

  it("queues a request that arrives mid-pass rather than refusing it", async function () {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const api = makeRunnableApi({
      names: ["ontology", "context", "statements", "track"],
      onReason: () => gate,
    });

    api.startReasoning();
    const second = api.startReasoning({ scope: "track:track-legacy" });
    assert.deepEqual(second, { started: false, queued: true, running: true, scope: "track:track-legacy" });

    release();
    await settle(api);
    // Two passes ran: the original, then the queued one.
    assert.equal(api.calls.length, 2);
    assert.deepEqual(api.calls[1].selector, { "dcterms:isPartOf": "track:track-legacy" });
  });

  it("honours a one-pass collections override", async function () {
    const api = makeRunnableApi({
      names: ["ontology", "context", "statements", "animal", "species", "track"],
    });
    api.startReasoning({ collections: ["track"] });
    await settle(api);
    assert.deepEqual(api.calls.map(c => c.name), ["track"]);
  });

  it("releases the guard and records the error when a pass throws", async function () {
    const api = makeRunnableApi({
      names: ["ontology", "context", "statements", "track"],
      onReason: () => { throw new Error("hylar is down"); },
    });

    api.startReasoning();
    await settle(api);

    assert.isFalse(api.isReasoningRunning());
    const status = await api.reasoningStatus();
    assert.equal(status.lastRun.error, "hylar is down");
  });

  it("sums status across collections and reports the breakdown", async function () {
    const api = makeRunnableApi({
      names: ["ontology", "context", "statements", "species", "track"],
      docsByName: {
        species: [{ _id: "s1", "bold:reasoned": true }, { _id: "s2" }],
        track: [{ _id: "t1", "bold:reasoned": true }],
      },
    });

    const status = await api.reasoningStatus();
    assert.deepEqual(status.collections.species, { total: 2, reasoned: 1, unreasoned: 1 });
    assert.deepEqual(status.collections.track, { total: 1, reasoned: 1, unreasoned: 0 });
    assert.equal(status.total, 3);
    assert.equal(status.reasoned, 2);
    assert.equal(status.unreasoned, 1);
    assert.isFalse(status.running);
  });

  it("groups unreasoned documents by type and partition", async function () {
    const api = makeRunnableApi({
      names: ["ontology", "context", "statements", "track"],
      docsByName: {
        track: [
          { _id: "t1", "@type": ["track:CollarReport"], "dcterms:isPartOf": "track:track-2025" },
          { _id: "t2", "@type": ["track:CollarReport"], "dcterms:isPartOf": "track:track-2025" },
          { _id: "t3", "@type": ["bold:Animal"], "dcterms:isPartOf": "track:track-legacy" },
        ],
      },
    });

    const detail = await api.unreasonedDetail();
    assert.equal(detail.track.total, 3);
    assert.isFalse(detail.track.truncated);
    assert.equal(detail.track.groups[0].count, 2);
    assert.equal(detail.track.groups[0].type, "track:CollarReport");
    assert.equal(detail.track.groups[0].partition, "track:track-2025");
    assert.deepEqual(detail.track.groups[0].examples, ["t1", "t2"]);
  });

  it("reports an empty collection as zero rather than omitting it", async function () {
    const api = makeRunnableApi({ names: ["ontology", "context", "statements", "track"] });
    const detail = await api.unreasonedDetail();
    assert.deepEqual(detail.track, { total: 0, sampled: 0, truncated: false, groups: [] });
  });
});
