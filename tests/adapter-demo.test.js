import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { MeteorCollectionAdapter } from "../src/adapters/index.js";

// Helper function to create a mock statements collection
function createMockStatementsCollection() {
  return {
    findOne: () => null,
    find: () => ({
      fetch: () => [],
      toArray: () => Promise.resolve([])
    }),
    insert: () => Promise.resolve({ insertedId: "test-id" }),
    insertMany: () => Promise.resolve({ insertedIds: ["test-id-1", "test-id-2"] }),
    replaceOne: () => Promise.resolve({ modifiedCount: 1 }),
    count: () => 0
  };
}

describe("Collection Adapter Demo", function () {

  describe("Client-side usage with MeteorCollectionAdapter", function () {
    it("should work with Meteor collections on client", async function () {
      // Simulate Meteor collection behavior (sync methods)
      const clientOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:TestClass") {
            return {
              _id: "ex:TestClass",
              "@type": ["owl:Class"],
              "rdfs:label": "Test Class"
            };
          }
          return null;
        },
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const clientContextCollection = {
        findOne: () => null,
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const clientStatementsCollection = createMockStatementsCollection();

      // Create adapters for client-side Meteor collections
      const ontologyAdapter = new MeteorCollectionAdapter(clientOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(clientContextCollection, "Context");
      const statementsAdapter = new MeteorCollectionAdapter(clientStatementsCollection, "Statements");

      // Create Ontologize instance with adapters
      const ontologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      // Test the async getLabelFromId method
      const label = await ontologize.getLabelFromId("ex:TestClass");
      assert.equal(label, "Test Class");

      // Test that non-existent resources fall back to ID extraction
      const fallbackLabel = await ontologize.getLabelFromId("ex:UnknownClass");
      assert.equal(fallbackLabel, "UnknownClass");
    });
  });

  describe("Server-side usage with raw MongoDB collections", function () {
    it("should work with MongoDB collections directly", async function () {
      // Simulate MongoDB driver collection behavior (async methods)
      const serverOntologyCollection = {
        findOne: async (query) => {
          if (query._id === "ex:TestClass") {
            return {
              _id: "ex:TestClass",
              "@type": ["owl:Class"],
              "rdfs:label": "Test Class"
            };
          }
          return null;
        },
        find: () => ({ toArray: async () => [] }),
        countDocuments: async () => 0
      };

      const serverContextCollection = {
        findOne: async () => null,
        find: () => ({ toArray: async () => [] }),
        countDocuments: async () => 0
      };

      const serverStatementsCollection = createMockStatementsCollection();

      // Use raw MongoDB collections directly (no adapter)
      const ontologize = new Ontologize(serverOntologyCollection, serverContextCollection, serverStatementsCollection);

      // Test the async getLabelFromId method
      const label = await ontologize.getLabelFromId("ex:TestClass");
      assert.equal(label, "Test Class");

      // Test that non-existent resources fall back to ID extraction
      const fallbackLabel = await ontologize.getLabelFromId("ex:UnknownClass");
      assert.equal(fallbackLabel, "UnknownClass");
    });
  });

  describe("Cross-platform consistency", function () {
    it("should produce same results with both adapter and direct collection patterns", async function () {
      // Same test resource for both approaches
      const testResource = {
        _id: "ex:TestClass",
        "@type": ["owl:Class"],
        "rdfs:label": "Test Class"
      };

      // Meteor collection simulation (for client)
      const meteorCollection = {
        findOne: (query) => query._id === "ex:TestClass" ? testResource : null,
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      // MongoDB collection simulation (for server)
      const mongoCollection = {
        findOne: async (query) => query._id === "ex:TestClass" ? testResource : null,
        find: () => ({ toArray: async () => [] }),
        countDocuments: async () => 0
      };

      // Context collections
      const meteorContext = { findOne: () => null, find: () => ({ fetch: () => [] }), count: () => 0 };
      const mongoContext = { findOne: async () => null, find: () => ({ toArray: async () => [] }), countDocuments: async () => 0 };

      // Statements collections
      const meteorStatements = createMockStatementsCollection();
      const mongoStatements = createMockStatementsCollection();

      // Client-side: Use adapters with Meteor collections
      const clientOntologize = new Ontologize(
        new MeteorCollectionAdapter(meteorCollection, "Ontology"),
        new MeteorCollectionAdapter(meteorContext, "Context"),
        new MeteorCollectionAdapter(meteorStatements, "Statements")
      );

      // Server-side: Use raw MongoDB collections directly
      const serverOntologize = new Ontologize(mongoCollection, mongoContext, mongoStatements);

      // Test that both produce identical results
      const clientLabel = await clientOntologize.getLabelFromId("ex:TestClass");
      const serverLabel = await serverOntologize.getLabelFromId("ex:TestClass");

      assert.equal(clientLabel, serverLabel);
      assert.equal(clientLabel, "Test Class");

      // Test fallback behavior is consistent
      const clientFallback = await clientOntologize.getLabelFromId("ex:Unknown");
      const serverFallback = await serverOntologize.getLabelFromId("ex:Unknown");

      assert.equal(clientFallback, serverFallback);
      assert.equal(clientFallback, "Unknown");
    });
  });
});