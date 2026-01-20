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
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("OntologizeServer Bootstrap", function () {
  let ontologizeServer;
  let mockOntologyCollection;
  let mockContextCollection;
  let mockStatementsCollection;
  let insertedOntologyResources = [];
  let insertedStatements = [];
  let updatedOntologyResources = [];
  this.timeout(0); //(60000); // 60 second timeout for reasoning tests

  beforeEach(function () {
    // Reset collections
    insertedOntologyResources = [];
    insertedStatements = [];
    updatedOntologyResources = [];

    // Mock collections for testing
    mockOntologyCollection = {
      findOne: async (query) => {
        // Simulate finding resources
        if (query._id === "@context") {
          return { _id: "@context", "@context": {} };
        }
        return insertedOntologyResources.find(r => r._id === query._id) || null;
      },
      find: (query) => ({
        toArray: async () => {
          // Return inserted ontology resources for bootstrapping
          if (Object.keys(query || {}).length === 0) {
            return insertedOntologyResources;
          }
          return [];
        },
        fetch: () => insertedOntologyResources
      }),
      insertOne: async (doc) => {
        insertedOntologyResources.push(doc);
        return { insertedId: doc._id };
      },
      replaceOne: async (query, doc, options = {}) => {
        const index = insertedOntologyResources.findIndex(r => r._id === query._id);
        if (index >= 0) {
          insertedOntologyResources[index] = doc;
          updatedOntologyResources.push(doc);
          return { modifiedCount: 1 };
        }
        else if (options.upsert) {
          insertedOntologyResources.push(doc);
          return { modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
        }
        return { modifiedCount: 0 };
      },
      updateOne: async (query, update) => {
        const doc = insertedOntologyResources.find(r => r._id === query._id);
        if (doc && update.$set) {
          Object.assign(doc, update.$set);
        }
        return { modifiedCount: doc ? 1 : 0 };
      },
      deleteMany: async () => {
        const count = insertedOntologyResources.length;
        insertedOntologyResources = [];
        return { deletedCount: count };
      },
      count: () => insertedOntologyResources.length
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
      replaceOne: async () => ({ modifiedCount: 1 }),
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

  describe("bootstrapReasoner", function () {
    beforeEach(async function () {
      // Pre-load some test ontology resources
      const testResources = [
        {
          _id: "bfo:entity",
          "@type": ["owl:Class"],
          "rdfs:label": "entity",
          "rdfs:comment": "An entity is anything that exists or has existed or will exist."
        },
        {
          _id: "bfo:continuant",
          "@type": ["owl:Class"],
          "rdfs:label": "continuant",
          "rdfs:subClassOf": ["bfo:entity"],
          "rdfs:comment": "A continuant is an entity that persists through time."
        },
        {
          _id: "bfo:occurrent",
          "@type": ["owl:Class"],
          "rdfs:label": "occurrent",
          "rdfs:subClassOf": ["bfo:entity"],
          "owl:disjointWith": ["bfo:continuant"],
          "rdfs:comment": "An occurrent is an entity that unfolds in time."
        },
        {
          _id: "bfo:has-part",
          "@type": ["owl:ObjectProperty"],
          "rdfs:label": "has part",
          "owl:inverseOf": "bfo:part-of"
        },
        {
          _id: "bfo:part-of",
          "@type": ["owl:ObjectProperty", "owl:TransitiveProperty"],
          "rdfs:label": "part of",
          "owl:inverseOf": "bfo:has-part"
        }
      ];

      for (const resource of testResources) {
        await mockOntologyCollection.insertOne(resource);
      }
    });

    it("should have bootstrapReasoner method", function () {
      assert.isFunction(ontologizeServer.bootstrapReasoner);
    });

    it("should load ontology resources without HyLAR server", async function () {
      // Run bootstrap without HyLAR server (no reasoning)
      const result = await ontologizeServer.bootstrapReasoner({
        classify: false, // Skip classification since no HyLAR
        updateResources: false,
        persistStatements: false
      });

      assert.isObject(result);
      assert.property(result, "resourcesLoaded");
      assert.property(result, "triplesGenerated");
      assert.property(result, "duration");

      // Should have loaded our test resources
      assert.equal(result.resourcesLoaded, 5);

      // Should have generated triples (even without HyLAR)
      assert.isAbove(result.triplesGenerated, 0);
    });

    it("should handle missing HyLAR server gracefully", async function () {
      // Try to bootstrap with a non-existent HyLAR server
      try {
        await ontologizeServer.bootstrapReasoner({
          hylarUrl: "http://localhost:9999", // Non-existent port
          classify: true
        });
        assert.fail("Should have thrown error for missing HyLAR server");
      }
      catch (error) {
        assert.include(error.message, "HyLAR server not available.");
      }
    });

    it("should generate triples from ontology resources", async function () {
      const result = await ontologizeServer.bootstrapReasoner({
        classify: false
      });

      // Check that triples were generated
      assert.isAbove(result.triplesGenerated, 0);

      // Should generate multiple triples per resource (type, label, subClassOf, etc.)
      assert.isAbove(result.triplesGenerated, result.resourcesLoaded);
    });

    it("should create SPARQL INSERT from resources", async function () {
      // Get test resources
      const resources = await mockOntologyCollection.find({}).toArray();

      // Convert to triples
      const triples = await ontologizeServer.getTriplesForResources(resources, {
        blankNodes: true,
        includeStatements: false
      });

      assert.isArray(triples);
      assert.isAbove(triples.length, 0);

      // Create SPARQL INSERT
      const sparqlInsert = await ontologizeServer.createSparqlInsert(triples);

      assert.isString(sparqlInsert);
      assert.include(sparqlInsert, "INSERT DATA");
      assert.include(sparqlInsert, "https://ontology.2wav.com/bfo#entity");
      assert.include(sparqlInsert, "http://www.w3.org/2000/01/rdf-schema#label");
      assert.include(sparqlInsert, "http://www.w3.org/2002/07/owl#Class");
    });

    // Integration test with real HyLAR (skip if HyLAR not available)
    it.skip("should bootstrap with HyLAR reasoning server", async function () {
      // This test requires HyLAR server to be running on port 4000
      // Skip it in CI or when HyLAR is not available

      const result = await ontologizeServer.bootstrapReasoner({
        hylarUrl: "http://localhost:4000",
        classify: true,
        updateResources: true,
        persistStatements: true
      });

      assert.isObject(result);
      assert.isAbove(result.factsInferred, 0);
      assert.isAbove(result.statementsCreated, 0);
      assert.isAbove(result.resourcesUpdated, 0);

      // Check that statements were persisted
      assert.isAbove(insertedStatements.length, 0);

      // Check that resources were updated
      assert.isAbove(updatedOntologyResources.length, 0);
    });

    it("should support private helper methods", function () {
      // Test _derivationsToFacts
      const derivations = [
        {
          subject: "bfo:entity",
          predicate: "rdf:type",
          object: "owl:Thing",
          explicit: false,
          rule: { name: "rdfs11" }
        }
      ];

      const facts = ontologizeServer._derivationsToFacts(derivations);
      assert.isArray(facts);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].subject, "bfo:entity");
      assert.equal(facts[0].explicit, false);

      // Test _derivationsToFacts with empty input
      assert.deepEqual(ontologizeServer._derivationsToFacts(null), []);
      assert.deepEqual(ontologizeServer._derivationsToFacts([]), []);
    });

    it("should persist statements when collection available", async function () {
      const testStatements = [
        {
          "@type": ["rdf:Statement"],
          "rdf:subject": "bfo:entity",
          "rdf:predicate": "rdf:type",
          "rdf:object": "owl:Thing",
          "bold:inferredFrom": ["rdfs11"]
        },
        {
          "@type": ["rdf:Statement"],
          "rdf:subject": "bfo:continuant",
          "rdf:predicate": "rdfs:subClassOf",
          "rdf:object": "bfo:entity"
        }
      ];

      const count = await ontologizeServer._persistStatements(testStatements);
      assert.equal(count, 2);
      assert.equal(insertedStatements.length, 2);

      // Check that IDs were generated
      assert.property(insertedStatements[0], "_id");
      assert.match(insertedStatements[0]._id, /bold:statement-/);
    });

    it("should merge and update resources with inferred properties", async function () {
      const assembledResources = {
        "bfo:entity": {
          "@type": ["owl:Class", "owl:Thing"],
          "rdfs:label": "entity",
          "owl:sameAs": ["bfo:Entity"] // New inferred property
        },
        "bfo:continuant": {
          "@type": ["owl:Class"],
          "rdfs:subClassOf": ["bfo:entity", "owl:Thing"], // Added owl:Thing
          "rdfs:label": "continuant"
        }
      };

      const updateCount = await ontologizeServer._mergeAndUpdateResources(assembledResources);
      assert.equal(updateCount, 2);

      // Check that resources were updated
      const entityResource = insertedOntologyResources.find(r => r._id === "bfo:entity");
      assert.include(entityResource["@type"], "owl:Thing");
      assert.property(entityResource, "owl:sameAs");
    });
  });

  describe("bootstrapReasoner with BFO data", function () {
    it("should import and bootstrap BFO ontology", async function () {
      // First import BFO data
      const bfoPath = path.join(__dirname, "data", "bold-bfo.jsonld");
      const importResult = await ontologizeServer.importOntologyFromFile(
        bfoPath,
        mockOntologyCollection,
        { ontologize: true } // Merge TBox resources to ontology collection
      );

      assert.isObject(importResult);
      assert.isAbove(importResult.processedResources, 0);
      console.log(`Imported ${importResult.processedResources} BFO resources`);

      // Now bootstrap without HyLAR (just test loading)
      const bootstrapResult = await ontologizeServer.bootstrapReasoner({
        classify: false,
        updateResources: false,
        persistStatements: false
      });

      assert.isObject(bootstrapResult);
      assert.equal(bootstrapResult.resourcesLoaded, insertedOntologyResources.length);
      assert.isAbove(bootstrapResult.triplesGenerated, bootstrapResult.resourcesLoaded);
    });
  });

  describe("bootstrap() method", function () {
    it("should have bootstrap method", function () {
      assert.isFunction(ontologizeServer.bootstrap);
    });

    it("should throw error when no bootstrap files configured", async function () {
      try {
        await ontologizeServer.bootstrap();
        assert.fail("Should have thrown error");
      }
      catch (error) {
        assert.include(error.message, "No bootstrap files configured");
      }
    });

    it("should bootstrap from constructor opts.bootstrapFiles", async function () {
      // Create a new instance with bootstrapFiles
      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");

      const serverWithFiles = new OntologizeServer(ontologyAdapter, contextAdapter, statementsAdapter, {
        bootstrapFiles: ["bold-bfo.jsonld", "ontology.json"],
        bootstrapPath: path.join(__dirname, "data")
      });

      const result = await serverWithFiles.bootstrap();

      assert.isObject(result);
      assert.equal(result.filesProcessed, 2);
      assert.isArray(result.results);
      assert.equal(result.results.length, 2);

      // First file should succeed
      assert.property(result.results[0], "processedResources");
      assert.isAbove(result.results[0].processedResources, 0);

      // Second file should also succeed
      assert.property(result.results[1], "processedResources");
    });

    it("should bootstrap from opts.files parameter", async function () {
      const result = await ontologizeServer.bootstrap({
        files: ["bold-bfo.jsonld"],
        basePath: path.join(__dirname, "data")
      });

      assert.isObject(result);
      assert.equal(result.filesProcessed, 1);
      assert.isAbove(result.results[0].processedResources, 0);
    });

    it("should handle absolute file paths", async function () {
      const absolutePath = path.join(__dirname, "data", "bold-bfo.jsonld");

      const result = await ontologizeServer.bootstrap({
        files: [absolutePath]
      });

      assert.isObject(result);
      assert.equal(result.filesProcessed, 1);
      assert.isAbove(result.results[0].processedResources, 0);
    });

    it("should fail on first file error but continue on subsequent file errors", async function () {
      // First file missing should throw
      try {
        await ontologizeServer.bootstrap({
          files: ["nonexistent.jsonld"],
          basePath: path.join(__dirname, "data")
        });
        assert.fail("Should have thrown error");
      }
      catch (error) {
        assert.include(error.message, "Failed to load required file");
      }

      // Second file missing should be skipped
      const result = await ontologizeServer.bootstrap({
        files: ["bold-bfo.jsonld", "nonexistent.jsonld"],
        basePath: path.join(__dirname, "data")
      });

      assert.equal(result.filesProcessed, 2);
      assert.isAbove(result.results[0].processedResources, 0);
      assert.equal(result.results[1].skipped, true);
      assert.property(result.results[1], "error");
    });

    it("should clear collection only on first file when clearFirst=true", async function () {
      // Pre-populate with a resource
      await mockOntologyCollection.insertOne({
        _id: "test:existing",
        "@type": ["owl:Class"]
      });

      const initialCount = insertedOntologyResources.length;
      assert.equal(initialCount, 1);

      // Bootstrap with clearFirst=true (default)
      const result = await ontologizeServer.bootstrap({
        files: ["bold-bfo.jsonld"],
        basePath: path.join(__dirname, "data"),
        clearFirst: true
      });

      // The pre-existing resource should be gone (collection was cleared)
      const existingResource = insertedOntologyResources.find(r => r._id === "test:existing");
      assert.isUndefined(existingResource);
    });

    it("should preserve existing resources when clearFirst=false", async function () {
      // Pre-populate with a resource
      await mockOntologyCollection.insertOne({
        _id: "test:existing",
        "@type": ["owl:Class"]
      });

      // Bootstrap with clearFirst=false
      const result = await ontologizeServer.bootstrap({
        files: ["bold-bfo.jsonld"],
        basePath: path.join(__dirname, "data"),
        clearFirst: false
      });

      // The pre-existing resource should still be there
      const existingResource = insertedOntologyResources.find(r => r._id === "test:existing");
      assert.isDefined(existingResource);
    });
  });
});
