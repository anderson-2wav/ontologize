/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { HttpCollectionAdapter } from "../src/adapters/HttpCollectionAdapter.js";

/**
 * Build a stub fetchFn that serves docs by id and records every call.
 *
 * @param {object} docs - map of id -> doc; ids absent from the map 404
 * @returns {Function} fetchFn with a `.calls` array of requested URLs
 */
function stubFetch(docs = {}) {
  const fetchFn = async (url) => {
    fetchFn.calls.push(url);
    // Bulk dump: /doc-base/<collection>
    const bulkMatch = /\/docs\/([^/?]+)$/.exec(url);
    if (bulkMatch) {
      return jsonResponse(200, { docs: Object.values(docs) });
    }
    const id = decodeURIComponent(url.split("/").pop());
    if (!(id in docs)) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    return jsonResponse(200, { doc: docs[id] });
  };
  fetchFn.calls = [];
  return fetchFn;
}

function jsonResponse(status, body) {
  return { ok: true, status, statusText: "OK", json: async () => body };
}

describe("HttpCollectionAdapter", function () {
  const DOCS = {
    "bold:Animal": { _id: "bold:Animal", "@type": "owl:Class" },
    "bold:species": { _id: "bold:species", "@type": "owl:ObjectProperty" }
  };

  let fetchFn;
  let adapter;

  beforeEach(function () {
    fetchFn = stubFetch(DOCS);
    adapter = new HttpCollectionAdapter("ontology", {
      baseUrl: "/api/bold",
      fetchFn
    });
  });

  describe("findOne", function () {
    it("fetches a document by _id", async function () {
      const doc = await adapter.findOne({ _id: "bold:Animal" });
      assert.isObject(doc);
      assert.equal(doc._id, "bold:Animal");
      assert.equal(fetchFn.calls.length, 1);
    });

    it("returns null when the document is not found", async function () {
      const doc = await adapter.findOne({ _id: "bold:Missing" });
      assert.isNull(doc);
    });

    it("serves a repeated lookup from cache without re-fetching", async function () {
      await adapter.findOne({ _id: "bold:Animal" });
      await adapter.findOne({ _id: "bold:Animal" });
      assert.equal(fetchFn.calls.length, 1);
    });

    it("caches a not-found result so misses are not re-fetched", async function () {
      const first = await adapter.findOne({ _id: "bold:Missing" });
      const second = await adapter.findOne({ _id: "bold:Missing" });
      assert.isNull(first);
      assert.isNull(second);
      assert.equal(fetchFn.calls.length, 1);
    });

    it("coalesces concurrent lookups of the same id into one request", async function () {
      const [a, b, c] = await Promise.all([
        adapter.findOne({ _id: "bold:Animal" }),
        adapter.findOne({ _id: "bold:Animal" }),
        adapter.findOne({ _id: "bold:Animal" })
      ]);
      assert.equal(a._id, "bold:Animal");
      assert.deepEqual(a, b);
      assert.deepEqual(b, c);
      assert.equal(fetchFn.calls.length, 1);
    });

    it("url-encodes ids containing reserved characters", async function () {
      const slashed = stubFetch({ "http://example.org/Thing": { _id: "http://example.org/Thing" } });
      const a = new HttpCollectionAdapter("ontology", { baseUrl: "/api/bold", fetchFn: slashed });
      const doc = await a.findOne({ _id: "http://example.org/Thing" });
      assert.equal(doc._id, "http://example.org/Thing");
      assert.include(slashed.calls[0], encodeURIComponent("http://example.org/Thing"));
    });

    it("rejects a query that is not an id lookup", async function () {
      try {
        await adapter.findOne({ "@type": "owl:Class" });
        assert.fail("expected findOne to throw for a non-id query");
      }
      catch (err) {
        assert.match(err.message, /_id/);
      }
    });

    it("rejects an id lookup carrying extra query keys", async function () {
      try {
        await adapter.findOne({ _id: "bold:Animal", "@type": "owl:Class" });
        assert.fail("expected findOne to throw for a compound query");
      }
      catch (err) {
        assert.match(err.message, /_id/);
      }
    });

    it("throws when the server fails with a non-404 status", async function () {
      const failing = async () => ({ ok: false, status: 500, statusText: "Server Error" });
      const a = new HttpCollectionAdapter("ontology", { baseUrl: "/api/bold", fetchFn: failing });
      try {
        await a.findOne({ _id: "bold:Animal" });
        assert.fail("expected findOne to throw on a 500");
      }
      catch (err) {
        assert.match(err.message, /500/);
      }
    });

    it("does not cache a failed request, so a later call retries", async function () {
      let calls = 0;
      const flaky = async (url) => {
        calls++;
        if (calls === 1) return { ok: false, status: 500, statusText: "Server Error" };
        return jsonResponse(200, { doc: DOCS["bold:Animal"] });
      };
      const a = new HttpCollectionAdapter("ontology", { baseUrl: "/api/bold", fetchFn: flaky });
      try { await a.findOne({ _id: "bold:Animal" }); }
      catch { /* expected */ }
      const doc = await a.findOne({ _id: "bold:Animal" });
      assert.equal(doc._id, "bold:Animal");
      assert.equal(calls, 2);
    });
  });

  describe("seeding", function () {
    it("serves seeded documents without fetching", async function () {
      adapter.seed([{ _id: "bold:Seeded" }]);
      const doc = await adapter.findOne({ _id: "bold:Seeded" });
      assert.equal(doc._id, "bold:Seeded");
      assert.equal(fetchFn.calls.length, 0);
    });

    it("populates the whole collection with a single request via seedAll", async function () {
      await adapter.seedAll();
      assert.equal(fetchFn.calls.length, 1);

      const animal = await adapter.findOne({ _id: "bold:Animal" });
      const species = await adapter.findOne({ _id: "bold:species" });
      assert.equal(animal._id, "bold:Animal");
      assert.equal(species._id, "bold:species");
      assert.equal(fetchFn.calls.length, 1, "seeded lookups must not re-fetch");
    });

    it("shares an injected cache between adapters", async function () {
      const cache = new Map();
      const a = new HttpCollectionAdapter("ontology", { baseUrl: "/api/bold", fetchFn, cache });
      const b = new HttpCollectionAdapter("ontology", { baseUrl: "/api/bold", fetchFn, cache });
      await a.findOne({ _id: "bold:Animal" });
      await b.findOne({ _id: "bold:Animal" });
      assert.equal(fetchFn.calls.length, 1);
    });
  });

  describe("unsupported operations", function () {
    const cases = [
      ["find", (a) => a.find({})],
      ["aggregate", (a) => a.aggregate([])],
      ["rawCollection", (a) => a.rawCollection()],
      ["countDocuments", (a) => a.countDocuments({})],
      ["count", (a) => a.count({})],
      ["insertOne", (a) => a.insertOne({})],
      ["insertMany", (a) => a.insertMany([])],
      ["updateOne", (a) => a.updateOne({}, {})],
      ["replaceOne", (a) => a.replaceOne({}, {})],
      ["deleteMany", (a) => a.deleteMany({})]
    ];

    for (const [name, invoke] of cases) {
      it(`throws a descriptive error for ${name}`, function () {
        assert.throws(() => invoke(adapter), new RegExp(name));
      });
    }

    it("names the supported alternative in the error", function () {
      assert.throws(() => adapter.find({}), /server-side|resources/i);
    });
  });

  describe("construction", function () {
    it("requires a collection name", function () {
      assert.throws(() => new HttpCollectionAdapter(), /name/i);
    });

    it("exposes the collection name", function () {
      assert.equal(adapter.name, "ontology");
    });
  });
});
