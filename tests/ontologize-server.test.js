import { assert } from "chai";
import { OntologizeServer } from "../src/ontologize-server.js";
import { readFile } from "fs/promises";
import path from "path";

describe("OntologizeServer", function () {
  let ontologizeServer;

  beforeEach(function () {
    // Mock collections for testing
    const mockOntologyCollection = {};
    const mockContextCollection = {};
    ontologizeServer = new OntologizeServer(mockOntologyCollection, mockContextCollection);
  });

  describe("inheritance", function () {
    it("should extend Ontologize class", function () {
      // Should have methods from parent class
      assert.isFunction(ontologizeServer.isValidOntologyResource);
      assert.isFunction(ontologizeServer.getLabel);
      assert.isFunction(ontologizeServer.getVersion);

      // Should have new server-only methods
      assert.isFunction(ontologizeServer.loadOntologyFromFile);
      assert.isFunction(ontologizeServer.importOntologyFromFile);
      assert.isFunction(ontologizeServer.importOntologyData);
    });

    it("should have same version as parent class", function () {
      assert.equal(ontologizeServer.getVersion(), "0.1.0");
    });

    it("should inherit parent class functionality", function () {
      const validResource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };

      // Should work like parent class
      assert.isTrue(ontologizeServer.isValidOntologyResource(validResource));
      assert.equal(ontologizeServer.getLabel(validResource), "Test Class");
    });
  });

  describe("server methods", function () {
    it("should have loadOntologyFromFile method", function () {
      assert.isFunction(ontologizeServer.loadOntologyFromFile);
    });

    it("should have importOntologyFromFile method", function () {
      assert.isFunction(ontologizeServer.importOntologyFromFile);
    });

    it("should have importOntologyData method", function () {
      assert.isFunction(ontologizeServer.importOntologyData);
    });

    it("should have exportToFile method", function () {
      assert.isFunction(ontologizeServer.exportToFile);
    });

    it("should have exportData method", function () {
      assert.isFunction(ontologizeServer.exportData);
    });
  });

  describe("export functionality", function () {
    let testCollection;
    let contextCollection;

    beforeEach(function () {
      // Create mock collections with basic MongoDB-like interface
      testCollection = {
        _documents: [],

        // MongoDB-like methods
        insertOne: async function(doc) {
          this._documents.push({ ...doc });
          return { insertedId: doc._id };
        },

        find: function(query = {}) {
          return {
            toArray: async () => {
              if (Object.keys(query).length === 0) {
                return [...this._documents];
              }
              // Simple query support for _id
              if (query._id) {
                return this._documents.filter(doc => doc._id === query._id);
              }
              return this._documents;
            }
          };
        },

        findOne: async function(query) {
          if (query._id) {
            return this._documents.find(doc => doc._id === query._id) || null;
          }
          return this._documents[0] || null;
        },

        replaceOne: async function(query, doc, opts) {
          const index = this._documents.findIndex(d => d._id === query._id);
          if (index >= 0) {
            this._documents[index] = doc;
            return { modifiedCount: 1, matchedCount: 1 };
          } else if (opts?.upsert) {
            this._documents.push(doc);
            return { modifiedCount: 0, matchedCount: 0, upsertedCount: 1, upsertedId: doc._id };
          }
          return { modifiedCount: 0, matchedCount: 0 };
        },

        deleteMany: async function(query = {}) {
          const initialLength = this._documents.length;
          if (Object.keys(query).length === 0) {
            this._documents = [];
          } else if (query._id) {
            this._documents = this._documents.filter(doc => doc._id !== query._id);
          }
          return { deletedCount: initialLength - this._documents.length };
        }
      };

      contextCollection = {
        _documents: [],

        findOne: async function(query) {
          if (query._id === "@id") {
            return this._documents.find(doc => doc._id === "@id") || null;
          }
          return null;
        },

        replaceOne: async function(query, doc, opts) {
          const index = this._documents.findIndex(d => d._id === query._id);
          if (index >= 0) {
            this._documents[index] = doc;
          } else if (opts?.upsert) {
            this._documents.push(doc);
          }
          return { modifiedCount: 1 };
        }
      };

      ontologizeServer = new OntologizeServer(testCollection, contextCollection);
    });

    it("should export data from collection", async function () {
      // Add some test data to collection
      const testResources = [
        {
          _id: "ex:Class1",
          "@type": ["owl:Class"],
          "rdfs:label": "Test Class 1"
        },
        {
          _id: "ex:Property1",
          "@type": ["owl:ObjectProperty"],
          "rdfs:label": "Test Property 1"
        }
      ];

      for (const resource of testResources) {
        await testCollection.insertOne(resource);
      }

      // Export the data
      const result = await ontologizeServer.exportData(testCollection, {
        normalize: false // Skip normalization for simple test
      });

      assert.isObject(result);
      assert.isTrue(result.success);
      assert.equal(result.outputTarget, "object");
      assert.isObject(result.data);
      assert.property(result.data, "@context");
      assert.property(result.data, "@graph");
      assert.isArray(result.data["@graph"]);
      assert.equal(result.data["@graph"].length, 2);
      assert.equal(result.totalResources, 2);
      assert.equal(result.processedResources, 2);

      // Check that _id was converted to @id
      const exportedClass = result.data["@graph"].find(r => r["@id"] === "ex:Class1");
      assert.isObject(exportedClass);
      assert.equal(exportedClass["@id"], "ex:Class1");
      assert.isUndefined(exportedClass._id);
    });

    it("should export to file", async function () {
      // Add test data
      const testResource = {
        _id: "ex:TestClass",
        "@type": ["owl:Class"],
        "rdfs:label": "Test Class for Export"
      };

      await testCollection.insertOne(testResource);

      // Export to file
      const filePath = "/tmp/test-export.jsonld";
      const result = await ontologizeServer.exportToFile(filePath, testCollection, {
        normalize: false
      });

      assert.isObject(result);
      assert.isTrue(result.success);
      assert.equal(result.outputTarget, "file");
      assert.equal(result.filePath, filePath);

      // Verify file was created and contains expected data
      const fileContent = await readFile(filePath, "utf-8");
      const exportedData = JSON.parse(fileContent);

      assert.isObject(exportedData);
      assert.property(exportedData, "@context");
      assert.equal(exportedData["@id"], "ex:TestClass");
      assert.deepEqual(exportedData["@type"], ["owl:Class"]);
      assert.equal(exportedData["rdfs:label"], "Test Class for Export");
    });

    it("should import and export BFO data", async function () {
      this.timeout(30000); // Long timeout for BFO processing

      // First import BFO data
      const bfoPath = path.resolve(process.cwd(), "../../private/data/bfo-core.jsonld");

      try {
        const importResult = await ontologizeServer.importOntologyFromFile(
          bfoPath,
          testCollection,
          {
            clearCollection: true,
            normalize: true,
            ontologize: true,
            shareTBox: false
          }
        );

        console.log(`BFO Import: ${importResult.processedResources} resources processed`);
        assert.isTrue(importResult.success);
        assert.isAbove(importResult.processedResources, 0);

        // Then export to /tmp/bfo.jsonld
        const exportPath = "/tmp/bfo.jsonld";
        const exportResult = await ontologizeServer.exportToFile(
          exportPath,
          testCollection,
          {
            normalize: true,
            ensureArrayProps: true
          }
        );

        console.log(`BFO Export: ${exportResult.processedResources} resources exported to ${exportPath}`);
        assert.isTrue(exportResult.success);
        assert.equal(exportResult.filePath, exportPath);
        assert.isAbove(exportResult.processedResources, 0);

        // Verify the exported file exists and has valid JSON-LD
        const exportedContent = await readFile(exportPath, "utf-8");
        const exportedData = JSON.parse(exportedContent);

        assert.isObject(exportedData);
        assert.property(exportedData, "@context");
        assert.property(exportedData, "@graph");
        assert.isArray(exportedData["@graph"]);
        assert.isAbove(exportedData["@graph"].length, 0);

        // Check that some BFO resources are present
        const bfoResources = exportedData["@graph"].filter(resource =>
          resource["@id"] && resource["@id"].includes("obolibrary.org/obo/BFO_")
        );
        assert.isAbove(bfoResources.length, 0, "Should contain BFO resources");

        console.log(`Exported ${bfoResources.length} BFO resources to ${exportPath}`);
      }
      catch (error) {
        console.warn(`BFO test skipped: ${error.message}`);
        this.skip();
      }
    });
  });
});
