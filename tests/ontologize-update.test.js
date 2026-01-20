/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
 */

import { assert } from "chai";
import { OntologizeServer } from "../src/OntologizeServer.js";
import { MeteorCollectionAdapter } from "../src/adapters/MeteorCollectionAdapter.js";

describe("OntologizeServer updateOne", function () {
  let ontologizeServer;
  let mockOntologyCollection;
  let mockContextCollection;
  let mockStatementsCollection;
  let storedResources = {};
  let insertedStatements = [];

  beforeEach(function () {
    // Reset collections
    storedResources = {};
    insertedStatements = [];

    // Pre-populate with test resources
    storedResources = {
      "bfo:entity": {
        _id: "bfo:entity",
        "@type": ["owl:Class"],
        "rdfs:label": "entity",
        "rdfs:comment": "An entity is anything that exists or has existed or will exist."
      },
      "bfo:continuant": {
        _id: "bfo:continuant",
        "@type": ["owl:Class"],
        "rdfs:label": "continuant",
        "rdfs:subClassOf": ["bfo:entity"],
        "rdfs:comment": "A continuant is an entity that persists through time."
      },
      "bfo:occurrent": {
        _id: "bfo:occurrent",
        "@type": ["owl:Class"],
        "rdfs:label": "occurrent",
        "rdfs:subClassOf": ["bfo:entity"],
        "owl:disjointWith": ["bfo:continuant"]
      },
      "bfo:material-entity": {
        _id: "bfo:material-entity",
        "@type": ["owl:Class"],
        "rdfs:label": "material entity",
        "rdfs:subClassOf": ["bfo:independent-continuant"]
      },
      "bfo:independent-continuant": {
        _id: "bfo:independent-continuant",
        "@type": ["owl:Class"],
        "rdfs:label": "independent continuant",
        "rdfs:subClassOf": ["bfo:continuant"]
      }
    };

    // Mock collections for testing
    mockOntologyCollection = {
      findOne: async (query) => {
        if (query._id === "@context") {
          return { _id: "@context", "@context": {} };
        }
        return storedResources[query._id] || null;
      },
      find: (query) => ({
        toArray: async () => {
          if (Object.keys(query || {}).length === 0) {
            return Object.values(storedResources);
          }
          return [];
        },
        fetch: () => Object.values(storedResources)
      }),
      insertOne: async (doc) => {
        storedResources[doc._id] = doc;
        return { insertedId: doc._id };
      },
      replaceOne: async (query, doc) => {
        if (storedResources[query._id]) {
          storedResources[query._id] = doc;
          return { modifiedCount: 1, upsertedCount: 0 };
        }
        return { modifiedCount: 0, upsertedCount: 0 };
      },
      updateOne: async (query, update) => {
        const doc = storedResources[query._id];
        if (doc && update.$set) {
          Object.assign(doc, update.$set);
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      },
      count: () => Object.keys(storedResources).length
    };

    mockContextCollection = {
      findOne: async (query) => {
        if (query._id === "@context") {
          return {
            _id: "@context",
            "@context": {
              "@vocab": "https://ontology.2wav.com/bold#",
              "bfo": "https://ontology.2wav.com/bfo#",
              "owl": "http://www.w3.org/2002/07/owl#",
              "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
              "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
            }
          };
        }
        return null;
      },
      find: () => ({
        toArray: async () => [],
        fetch: () => []
      }),
      updateOne: async () => ({ modifiedCount: 0 }),
      count: () => 0
    };

    mockStatementsCollection = {
      findOne: async () => null,
      find: () => ({
        toArray: async () => insertedStatements,
        fetch: () => insertedStatements
      }),
      insertMany: async (docs) => {
        insertedStatements.push(...docs);
        return {
          insertedCount: docs.length,
          insertedIds: docs.map(d => d._id)
        };
      },
      deleteMany: async () => {
        const count = insertedStatements.length;
        insertedStatements = [];
        return { deletedCount: count };
      },
      count: () => insertedStatements.length
    };

    // Create adapters
    const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
    const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
    const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");

    // Create OntologizeServer instance
    ontologizeServer = new OntologizeServer(ontologyAdapter, contextAdapter, statementsAdapter);
  });

  describe("updateOne method", function () {

    it("should have updateOne method", function () {
      assert.isFunction(ontologizeServer.updateOne);
    });

    it("should update resource without reasoning", async function () {
      const update = {
        "rdfs:comment": "Updated comment for entity",
        "skos:altLabel": "thing"
      };

      const result = await ontologizeServer.updateOne("bfo:entity", update, {
        reasoning: false
      });

      assert.isObject(result);
      assert.property(result, "resource");
      assert.property(result, "updateResult");
      assert.property(result, "inferredCount");

      // Check resource was updated
      assert.include(result.resource["rdfs:comment"], "Updated comment for entity");
      assert.equal(result.resource["skos:altLabel"], "thing");

      // No inferences without reasoning
      assert.equal(result.inferredCount, 0);

      // Check in storage
      const stored = storedResources["bfo:entity"];
      assert.include(stored["rdfs:comment"], "Updated comment for entity");
      assert.equal(stored["skos:altLabel"], "thing");
    });

    it("should throw error for non-existent resource", async function () {
      try {
        await ontologizeServer.updateOne("bfo:nonexistent", {
          "rdfs:label": "test"
        });
        assert.fail("Should have thrown error");
      }
      catch (error) {
        assert.include(error.message, "Resource not found");
      }
    });

    it("should merge updates with existing properties", async function () {
      const update = {
        "rdfs:seeAlso": ["http://example.org/entity"],
        "owl:equivalentClass": ["owl:Thing"]
      };

      const result = await ontologizeServer.updateOne("bfo:entity", update, {
        reasoning: false
      });

      // Should retain existing properties
      assert.equal(result.resource["rdfs:label"], "entity");
      assert.equal(result.resource._id, "bfo:entity");
      assert.include(result.resource["@type"], "owl:Class");

      // Should add new properties
      assert.deepEqual(result.resource["rdfs:seeAlso"], "http://example.org/entity");
      assert.deepEqual(result.resource["owl:equivalentClass"], "owl:Thing");
    });

    it("should handle array merging correctly", async function () {
      // Update continuant which already has rdfs:subClassOf
      const update = {
        "rdfs:subClassOf": ["owl:Thing"]
      };

      const result = await ontologizeServer.updateOne("bfo:continuant", update, {
        reasoning: false
      });

      // Should merge arrays (union)
      assert.include(result.resource["rdfs:subClassOf"], "bfo:entity");
      assert.include(result.resource["rdfs:subClassOf"], "owl:Thing");
      assert.equal(result.resource["rdfs:subClassOf"].length, 2);
    });

    it("should handle reasoning unavailable gracefully", async function () {
      const update = {
        "rdfs:label": "updated entity"
      };

      // With reasoning=true but HyLAR not available
      const result = await ontologizeServer.updateOne("bfo:entity", update, {
        reasoning: true,
        hylarUrl: "http://localhost:9999" // Non-existent
      });

      // Should still update without reasoning
      assert.include(result.resource["rdfs:label"], "updated entity");
      assert.equal(result.inferredCount, 0);

      // Should have logged warning (check console output in test)
    });

    it("should protect resource _id", async function () {
      // this test has changed. we can't update a resource with a resource that has conflicting _id
      const update = {
        "_id": "should-be-rejecte",
        "rdfs:label": "new label"
      };
      try {
        await ontologizeServer.updateOne("bfo:entity", update, {reasoning: false});
      }
      catch (error) {
        assert.include(error.message, "All resources must have the same ID for merging.");
      }
    });

    it("should include statements when requested", async function () {
      const update = {
        "rdfs:comment": "Updated"
      };

      const result = await ontologizeServer.updateOne("bfo:entity", update, {
        reasoning: false,
        includeStatements: true
      });

      // Statements should be included (empty without reasoning)
      assert.property(result, "statements");
      assert.isArray(result.statements);
    });

    it("should support userId for provenance", async function () {
      // This would be tested with actual HyLAR reasoning
      const update = {
        "rdfs:label": "updated by user"
      };

      const result = await ontologizeServer.updateOne("bfo:entity", update, {
        reasoning: false,
        userId: "test-user-123"
      });

      assert.isObject(result);
      // userId would be used in statement creation with reasoning
    });

    it("should handle complex nested updates", async function () {
      const update = {
        "rdfs:label": ["entity", "thing"],
        "rdfs:comment": {
          "en": "English comment",
          "es": "Comentario español"
        },
        "owl:equivalentClass": [
          { "@id": "owl:Thing" },
          { "@id": "rdfs:Resource" }
        ]
      };

      const result = await ontologizeServer.updateOne("bfo:entity", update, {
        reasoning: false
      });

      assert.deepEqual(result.resource["rdfs:label"], ["entity", "thing"]);
      assert.deepEqual(result.resource["rdfs:comment"], {
        "en": "English comment",
        "es": "Comentario español"
      });
      assert.isArray(result.resource["owl:equivalentClass"]);
      assert.equal(result.resource["owl:equivalentClass"].length, 2);
    });

    it("should update transitivity hierarchy", async function () {
      // Update material-entity to be subclass of both independent-continuant and entity
      const update = {
        "rdfs:subClassOf": ["bfo:independent-continuant", "bfo:entity"]
      };

      const result = await ontologizeServer.updateOne("bfo:material-entity", update, {
        reasoning: false
      });

      assert.include(result.resource["rdfs:subClassOf"], "bfo:independent-continuant");
      assert.include(result.resource["rdfs:subClassOf"], "bfo:entity");

      // In a real reasoning scenario, this would trigger transitive closure
      // and infer additional subClassOf relationships
    });

    // Integration test with real HyLAR (skip if HyLAR not available)
    it.skip("should update with HyLAR reasoning", async function () {
      // This test requires HyLAR server to be running
      // Skip it in CI or when HyLAR is not available

      const update = {
        "rdfs:subClassOf": ["owl:Thing"]
      };

      const result = await ontologizeServer.updateOne("bfo:continuant", update, {
        reasoning: true,
        hylarUrl: "http://localhost:4000",
        persistToHylar: false
      });

      assert.isObject(result);
      assert.isAbove(result.inferredCount, 0);

      // Should have inferred properties
      assert.include(result.resource["@type"], "owl:Thing");

      // Should have created statements
      assert.isAbove(insertedStatements.length, 0);
    });
  });

  describe("updateOne with bootstrap context", function () {
    beforeEach(async function () {
      // Simulate a bootstrapped ontology with more resources
      storedResources["bfo:process"] = {
        _id: "bfo:process",
        "@type": ["owl:Class"],
        "rdfs:label": "process",
        "rdfs:subClassOf": ["bfo:occurrent"]
      };

      storedResources["bfo:temporal-region"] = {
        _id: "bfo:temporal-region",
        "@type": ["owl:Class"],
        "rdfs:label": "temporal region",
        "rdfs:subClassOf": ["bfo:occurrent"]
      };
    });

    it("should update process with new properties", async function () {
      const update = {
        "rdfs:comment": "A process is an occurrent that happens over time",
        "owl:disjointWith": ["bfo:temporal-region"]
      };

      const result = await ontologizeServer.updateOne("bfo:process", update, {
        reasoning: false
      });

      assert.equal(result.resource["rdfs:comment"], "A process is an occurrent that happens over time");
      assert.include(result.resource["owl:disjointWith"], "bfo:temporal-region");
    });

    it("should handle batch updates sequentially", async function () {
      const updates = [
        { id: "bfo:process", update: { "skos:prefLabel": "Process" } },
        { id: "bfo:temporal-region", update: { "skos:prefLabel": "Temporal Region" } },
        { id: "bfo:occurrent", update: { "skos:prefLabel": "Occurrent" } }
      ];

      for (const { id, update } of updates) {
        const result = await ontologizeServer.updateOne(id, update, {
          reasoning: false
        });
        assert.property(result.resource, "skos:prefLabel");
      }

      // Verify all updates applied
      assert.equal(storedResources["bfo:process"]["skos:prefLabel"], "Process");
      assert.equal(storedResources["bfo:temporal-region"]["skos:prefLabel"], "Temporal Region");
      assert.equal(storedResources["bfo:occurrent"]["skos:prefLabel"], "Occurrent");
    });
  });
});
