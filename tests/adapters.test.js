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

    it("should wrap find and return Promise with array", async function () {
      const result = await adapter.find({});
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

      const array = await meteorAdapter.find({});
      assert.isArray(array);
      assert.equal(array.length, 1);

      const count = await meteorAdapter.count({});
      assert.isNumber(count);
      assert.equal(count, 1);
    });
  });
});