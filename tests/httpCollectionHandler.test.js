/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { createCollectionHandler } from "../src/adapters/httpCollectionHandler.js";

/** Minimal stand-in for a MongoDB driver collection. */
function driverCollection(docs) {
  return {
    findOne: async (query) => docs.find(d => d._id === query._id) ?? null,
    find: () => ({ toArray: async () => docs.slice() })
  };
}

describe("createCollectionHandler", function () {
  const ONTOLOGY = [
    { _id: "bold:Animal", "@type": "owl:Class" },
    { _id: "bold:species", "@type": "owl:ObjectProperty" }
  ];
  const ANIMALS = [{ _id: "animal:1", "@type": "bold:Animal" }];

  let handle;

  beforeEach(function () {
    handle = createCollectionHandler({
      collections: {
        ontology: driverCollection(ONTOLOGY),
        animal: () => driverCollection(ANIMALS)
      },
      allowBulk: ["ontology"]
    });
  });

  describe("single document", function () {
    it("returns the document for an allowlisted collection", async function () {
      const res = await handle({ method: "GET", kind: "doc", collection: "ontology", id: "bold:Animal" });
      assert.equal(res.status, 200);
      assert.equal(res.body.doc._id, "bold:Animal");
    });

    it("resolves a collection supplied as a thunk", async function () {
      const res = await handle({ method: "GET", kind: "doc", collection: "animal", id: "animal:1" });
      assert.equal(res.status, 200);
      assert.equal(res.body.doc._id, "animal:1");
    });

    it("404s when the document does not exist", async function () {
      const res = await handle({ method: "GET", kind: "doc", collection: "ontology", id: "bold:Nope" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "not-found");
    });

    it("404s for a collection that is not registered", async function () {
      const res = await handle({ method: "GET", kind: "doc", collection: "secrets", id: "x" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "unknown-collection");
    });

    it("400s when no id is supplied", async function () {
      const res = await handle({ method: "GET", kind: "doc", collection: "ontology" });
      assert.equal(res.status, 400);
    });

    it("405s for a non-GET method", async function () {
      const res = await handle({ method: "POST", kind: "doc", collection: "ontology", id: "bold:Animal" });
      assert.equal(res.status, 405);
    });
  });

  describe("bulk dump", function () {
    it("returns every document for a bulk-enabled collection", async function () {
      const res = await handle({ method: "GET", kind: "docs", collection: "ontology" });
      assert.equal(res.status, 200);
      assert.equal(res.body.docs.length, 2);
    });

    it("403s for a registered collection not opted into bulk", async function () {
      const res = await handle({ method: "GET", kind: "docs", collection: "animal" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, "bulk-not-allowed");
    });

    it("404s for an unregistered collection", async function () {
      const res = await handle({ method: "GET", kind: "docs", collection: "secrets" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "unknown-collection");
    });
  });

  describe("routing", function () {
    it("404s for an unrecognized request kind", async function () {
      const res = await handle({ method: "GET", kind: "nonsense", collection: "ontology" });
      assert.equal(res.status, 404);
    });

    it("500s with an error body when the collection throws", async function () {
      const broken = createCollectionHandler({
        collections: { ontology: { findOne: async () => { throw new Error("mongo is down"); } } }
      });
      const res = await broken({ method: "GET", kind: "doc", collection: "ontology", id: "x" });
      assert.equal(res.status, 500);
      assert.match(res.body.message, /mongo is down/);
    });
  });

  describe("configuration", function () {
    it("requires a collections map", function () {
      assert.throws(() => createCollectionHandler({}), /collections/i);
    });

    it("allows no bulk collections by default", async function () {
      const strict = createCollectionHandler({ collections: { ontology: driverCollection(ONTOLOGY) } });
      const res = await strict({ method: "GET", kind: "docs", collection: "ontology" });
      assert.equal(res.status, 403);
    });
  });
});
