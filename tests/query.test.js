/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
 */

import { assert } from "chai";
import { Query } from "../src/Query.js";

describe("Query", function () {

  const animalQuery = {
    name: "Animals",
    collection: "animal",
    selector: { "@type": "bold:Animal" },
    opts: { sort: { "bold:begin": 1 } }
  };

  describe("constructor", function () {
    it("should create a Query with all fields", function () {
      const q = new Query(animalQuery);
      assert.equal(q.name, "Animals");
      assert.equal(q.collection, "animal");
      assert.deepEqual(q.selector, { "@type": "bold:Animal" });
      assert.deepEqual(q.opts, { sort: { "bold:begin": 1 } });
    });

    it("should default selector and opts to empty objects", function () {
      const q = new Query({ name: "All", collection: "ontology" });
      assert.deepEqual(q.selector, {});
      assert.deepEqual(q.opts, {});
    });

    it("should throw if name is missing", function () {
      assert.throws(() => new Query({ collection: "animal" }), /name/);
    });

    it("should throw if collection is missing", function () {
      assert.throws(() => new Query({ name: "Animals" }), /collection/);
    });

    it("should throw if name is not a string", function () {
      assert.throws(() => new Query({ name: 42, collection: "animal" }), /name/);
    });

    it("should throw if collection is not a string", function () {
      assert.throws(() => new Query({ name: "Animals", collection: 123 }), /collection/);
    });

    it("should throw if selector is not an object", function () {
      assert.throws(() => new Query({ name: "X", collection: "c", selector: "bad" }));
    });

    it("should throw if opts is not an object", function () {
      assert.throws(() => new Query({ name: "X", collection: "c", opts: "bad" }));
    });
  });

  describe("from", function () {
    it("should return the same instance if already a Query", function () {
      const q = new Query(animalQuery);
      assert.strictEqual(Query.from(q), q);
    });

    it("should create a Query from a plain object", function () {
      const q = Query.from(animalQuery);
      assert.instanceOf(q, Query);
      assert.equal(q.name, "Animals");
      assert.equal(q.collection, "animal");
    });

    it("should validate when creating from a plain object", function () {
      assert.throws(() => Query.from({ name: 42 }));
    });
  });

  describe("toJSON", function () {
    it("should include @type discriminator", function () {
      const q = new Query(animalQuery);
      const json = q.toJSON();
      assert.equal(json["@type"], "ontologize:Query");
    });

    it("should round-trip through JSON serialization", function () {
      const q = new Query(animalQuery);
      const json = JSON.parse(JSON.stringify(q));
      assert.equal(json["@type"], "ontologize:Query");
      assert.equal(json.name, "Animals");
      assert.equal(json.collection, "animal");
      assert.deepEqual(json.selector, { "@type": "bold:Animal" });
      assert.deepEqual(json.opts, { sort: { "bold:begin": 1 } });
    });

    it("should round-trip through from(toJSON())", function () {
      const q1 = new Query(animalQuery);
      const q2 = Query.from(q1.toJSON());
      assert.instanceOf(q2, Query);
      assert.equal(q2.name, q1.name);
      assert.equal(q2.collection, q1.collection);
      assert.deepEqual(q2.selector, q1.selector);
      assert.deepEqual(q2.opts, q1.opts);
    });
  });

  describe("TYPE", function () {
    it("should be ontologize:Query", function () {
      assert.equal(Query.TYPE, "ontologize:Query");
    });
  });

});