/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { MeteorCollectionAdapter } from "../src/adapters/index.js";

describe("Collection Adapters", function () {
  
  describe("MeteorCollectionAdapter", function () {
    let adapter;
    let mockMeteorCollection;

    beforeEach(function () {
      mockMeteorCollection = {
        findOne: (query, options) => {
          if (query._id === "test:1") {
            return { _id: "test:1", name: "Test Resource" };
          }
          return null;
        },
        find: (query, options) => ({
          fetch: () => [
            { _id: "test:1", name: "Test Resource" },
            { _id: "test:2", name: "Another Resource" }
          ],
          count: () => 2
        })
      };

      adapter = new MeteorCollectionAdapter(mockMeteorCollection, "TestCollection");
    });

    it("should wrap findOne and return Promise", async function () {
      const result = await adapter.findOne({ _id: "test:1" });
      assert.isObject(result);
      assert.equal(result._id, "test:1");
      assert.equal(result.name, "Test Resource");
    });

    it("should return null for findOne when not found", async function () {
      const result = await adapter.findOne({ _id: "test:nonexistent" });
      assert.isNull(result);
    });

    it("should wrap find and return cursor with toArray method", async function () {
      const cursor = adapter.find({});
      assert.isObject(cursor);
      assert.isFunction(cursor.toArray);

      const result = await cursor.toArray();
      assert.isArray(result);
      assert.equal(result.length, 2);
      assert.equal(result[0]._id, "test:1");
      assert.equal(result[1]._id, "test:2");
    });

    it("should wrap count and return Promise with number", async function () {
      const result = await adapter.count({});
      assert.isNumber(result);
      assert.equal(result, 2);
    });

    it("should handle errors gracefully", async function () {
      const errorCollection = {
        findOne: () => { throw new Error("Database error"); }
      };
      const errorAdapter = new MeteorCollectionAdapter(errorCollection, "ErrorCollection");

      try {
        await errorAdapter.findOne({ _id: "test" });
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.include(error.message, "Error in ErrorCollection.findOne");
      }
    });
  });

  describe("MeteorCollectionAdapter.bulkWrite", function () {
    it("passes operations straight through when the collection has bulkWrite", async function () {
      let seen = null;
      let seenOpts = null;
      const raw = {
        bulkWrite: async (ops, opts) => {
          seen = ops;
          seenOpts = opts;
          return { modifiedCount: 2, insertedCount: 1 };
        }
      };
      const adapter = new MeteorCollectionAdapter(raw, "Raw");

      const ops = [
        { replaceOne: { filter: { _id: "a" }, replacement: { _id: "a", v: 1 }, upsert: false } },
        { insertOne: { document: { _id: "b" } } }
      ];
      const result = await adapter.bulkWrite(ops, { ordered: false });

      assert.strictEqual(seen, ops, "operations should not be rewritten");
      assert.deepEqual(seenOpts, { ordered: false });
      assert.equal(result.modifiedCount, 2);
      assert.equal(result.insertedCount, 1);
    });

    it("emulates replaceOne and insertOne when the collection has no bulkWrite", async function () {
      // The reasoner's merge path emits exactly these two ops; a Meteor
      // collection (as opposed to rawCollection()) has to replay them.
      const calls = [];
      const meteorCollection = {
        replaceOne: async (query, replacement, options) => {
          calls.push({ op: "replaceOne", query, replacement, options });
          return { modifiedCount: 1, matchedCount: 1, upsertedCount: 0 };
        },
        insertOne: async (doc) => {
          calls.push({ op: "insertOne", doc });
          return { insertedId: doc._id };
        }
      };
      const adapter = new MeteorCollectionAdapter(meteorCollection, "Emulated");

      const result = await adapter.bulkWrite([
        { replaceOne: { filter: { _id: "a" }, replacement: { _id: "a", v: 1 }, upsert: false } },
        { replaceOne: { filter: { _id: "b" }, replacement: { _id: "b", v: 2 }, upsert: false } },
        { insertOne: { document: { _id: "c", v: 3 } } }
      ]);

      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0].query, { _id: "a" });
      assert.deepEqual(calls[0].replacement, { _id: "a", v: 1 });
      assert.deepEqual(calls[0].options, { upsert: false });
      assert.equal(calls[2].op, "insertOne");
      assert.deepEqual(calls[2].doc, { _id: "c", v: 3 });

      assert.equal(result.modifiedCount, 2);
      assert.equal(result.matchedCount, 2);
      assert.equal(result.insertedCount, 1);
    });

    it("emulates updateOne when the collection has no bulkWrite", async function () {
      const calls = [];
      const meteorCollection = {
        updateOne: async (filter, update, options) => {
          calls.push({ filter, update, options });
          return { modifiedCount: 0, matchedCount: 0, upsertedCount: 1 };
        }
      };
      const adapter = new MeteorCollectionAdapter(meteorCollection, "Emulated");

      const result = await adapter.bulkWrite([
        { updateOne: { filter: { _id: "a" }, update: { $set: { v: 1 } }, upsert: true } }
      ]);

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].options, { upsert: true });
      assert.equal(result.upsertedCount, 1);
    });

    it("throws rather than silently skipping an unsupported operation", async function () {
      const adapter = new MeteorCollectionAdapter({ replaceOne: async () => ({}) }, "Emulated");

      try {
        await adapter.bulkWrite([{ deleteOne: { filter: { _id: "a" } } }]);
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.include(error.message, "unsupported operation deleteOne");
      }
    });
  });

  describe("MeteorCollectionAdapter Interface", function () {
    it("should provide consistent async interface for client-side usage", async function () {
      // Setup Meteor collection simulation
      const meteorCollection = {
        findOne: () => ({ _id: "test:1", name: "Test" }),
        find: () => ({ fetch: () => [{ _id: "test:1" }], count: () => 1 })
      };

      const meteorAdapter = new MeteorCollectionAdapter(meteorCollection, "Test");

      // Test that adapter provides async interface
      const result = await meteorAdapter.findOne({ _id: "test:1" });
      assert.isObject(result);
      assert.equal(result._id, "test:1");

      const cursor = meteorAdapter.find({});
      assert.isObject(cursor);
      assert.isFunction(cursor.toArray);

      const array = await cursor.toArray();
      assert.isArray(array);
      assert.equal(array.length, 1);

      const count = await meteorAdapter.count({});
      assert.isNumber(count);
      assert.equal(count, 1);
    });
  });
});