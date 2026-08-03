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

    /**
     * Mongo.Collection carries update/updateAsync and never the driver's
     * updateOne — so the adapter's write half only ever worked over a
     * rawCollection(). These pin the fallback that makes the client case work.
     */
    describe("writes over a Meteor collection", function () {
      let calls;
      let meteorish;
      let meteorAdapter;

      beforeEach(function () {
        calls = [];
        meteorish = {
          // Meteor resolves to the number of documents affected, not a result object.
          updateAsync: async (selector, modifier, options) => {
            calls.push({ kind: "update", selector, modifier, options });
            return 1;
          },
          upsertAsync: async (selector, modifier, options) => {
            calls.push({ kind: "upsert", selector, modifier, options });
            return { numberAffected: 1, insertedId: "test:new" };
          }
        };
        meteorAdapter = new MeteorCollectionAdapter(meteorish, "meteorish");
      });

      it("falls back to updateAsync when the driver name is absent", async function () {
        const result = await meteorAdapter.updateOne({ _id: "test:1" }, { $set: { x: 1 } });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].kind, "update");
        assert.deepEqual(calls[0].selector, { _id: "test:1" });
        assert.deepEqual(calls[0].modifier, { $set: { x: 1 } });
        assert.equal(result.matchedCount, 1);
        assert.equal(result.modifiedCount, 1);
        assert.equal(result.upsertedCount, 0);
      });

      it("routes an upsert through upsertAsync", async function () {
        const result = await meteorAdapter.updateOne(
          { _id: "test:new" }, { $set: { x: 1 } }, { upsert: true }
        );

        assert.equal(calls[0].kind, "upsert");
        assert.equal(result.upsertedCount, 1);
        assert.equal(result.upsertedId, "test:new");
      });

      it("emulates bulkWrite through its own updateOne, not the collection's", async function () {
        const result = await meteorAdapter.bulkWrite([
          { updateOne: { filter: { _id: "test:1" }, update: { $set: { x: 1 } } } },
          { updateOne: { filter: { _id: "test:2" }, update: { $set: { x: 2 } } } }
        ]);

        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].selector, { _id: "test:2" });
        assert.equal(result.modifiedCount, 2);
        assert.equal(result.matchedCount, 2);
      });

      it("prefers the native driver method when the collection has one", async function () {
        const driverish = {
          updateOne: async () => ({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }),
          updateAsync: async () => { throw new Error("updateAsync must not be called"); }
        };
        const driverAdapter = new MeteorCollectionAdapter(driverish, "driverish");

        const result = await driverAdapter.updateOne({ _id: "test:1" }, { $set: { x: 1 } });
        assert.equal(result.modifiedCount, 1);
      });
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