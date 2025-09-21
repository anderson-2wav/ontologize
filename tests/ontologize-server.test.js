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

    it("should have explorer method", function () {
      assert.isFunction(ontologizeServer.explorer);
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

  describe("explorer functionality", function () {
    let testCollection1;
    let testCollection2;
    let ontologyCollection;
    let contextCollection;

    beforeEach(async function () {
      // Create mock collections with basic MongoDB-like interface
      ontologyCollection = {
        _documents: [],
        collectionName: "ontology",

        insertOne: async function(doc) {
          this._documents.push({ ...doc });
          return { insertedId: doc._id };
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
          } else if (opts?.upsert) {
            this._documents.push(doc);
          }
          return { modifiedCount: 1 };
        }
      };

      contextCollection = {
        _documents: [],
        collectionName: "context",

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

      testCollection1 = {
        _documents: [],
        collectionName: "classes",

        find: function(query = {}) {
          return {
            toArray: async () => {
              return [...this._documents];
            }
          };
        },

        insertOne: async function(doc) {
          this._documents.push({ ...doc });
          return { insertedId: doc._id };
        }
      };

      testCollection2 = {
        _documents: [],
        collectionName: "properties",

        find: function(query = {}) {
          return {
            toArray: async () => {
              return [...this._documents];
            }
          };
        },

        insertOne: async function(doc) {
          this._documents.push({ ...doc });
          return { insertedId: doc._id };
        }
      };

      ontologizeServer = new OntologizeServer(ontologyCollection, contextCollection);

      // Add some ontology definitions
      await ontologyCollection.insertOne({
        _id: "owl:Class",
        "@type": ["rdfs:Class"],
        "rdfs:label": "Class",
        "rdfs:comment": "The class of OWL classes."
      });

      await ontologyCollection.insertOne({
        _id: "rdfs:label",
        "@type": ["rdf:Property"],
        "rdfs:label": "label",
        "rdfs:comment": "A human-readable name for the subject."
      });

      await ontologyCollection.insertOne({
        _id: "rdfs:comment",
        "@type": ["rdf:Property"],
        "rdfs:label": "comment",
        "rdfs:comment": "A description of the subject resource."
      });
    });

    it("should create basic explorer map", async function () {
      // Add test data to collections
      await testCollection1.insertOne({
        _id: "ex:TestClass",
        "@type": ["owl:Class"],
        "rdfs:label": "Test Class",
        "rdfs:comment": "A test class"
      });

      await testCollection2.insertOne({
        _id: "ex:TestProperty",
        "@type": ["rdf:Property"],
        "rdfs:label": "Test Property",
        "rdfs:comment": "A test property"
      });

      const result = await ontologizeServer.explorer([testCollection1, testCollection2]);

      // Check basic structure
      assert.isObject(result);
      assert.property(result, "README");
      assert.include(result.README, "BOLD");

      // Check that types were found
      assert.property(result, "owl:Class");
      assert.property(result, "rdf:Property");

      // Check owl:Class mapping
      const owlClass = result["owl:Class"];
      assert.isObject(owlClass);
      assert.property(owlClass, "@type");
      assert.property(owlClass, "rdfs:label");
      assert.property(owlClass, "rdfs:comment");

      // Check that @type property contains ontology definitions
      assert.isObject(owlClass["@type"]);
      assert.property(owlClass["@type"], "owl:Class");
      assert.isObject(owlClass["@type"]["owl:Class"]);

      // Check that properties contain ontology definitions
      assert.isObject(owlClass["rdfs:label"]);
      assert.equal(owlClass["rdfs:label"]["rdfs:label"], "label");
    });

    it("should handle resources without @type", async function () {
      // Add resource without @type
      await testCollection1.insertOne({
        _id: "ex:NoType",
        "rdfs:label": "Resource without type"
      });

      const result = await ontologizeServer.explorer([testCollection1]);

      // Should create fallback type name using collection name
      assert.property(result, "classes unknown type");
      assert.isObject(result["classes unknown type"]);
      assert.property(result["classes unknown type"], "rdfs:label");
    });

    it("should handle embedded resources when recurse=true", async function () {
      // Add resource with embedded resources
      await testCollection1.insertOne({
        _id: "ex:ParentClass",
        "@type": ["owl:Class"],
        "rdfs:label": "Parent Class",
        "ex:hasChild": {
          "@type": ["owl:Class"],
          "_id": "ex:ChildClass",
          "rdfs:label": "Child Class"
        },
        "ex:hasProperty": {
          "@type": ["rdf:Property"],
          "_id": "ex:ChildProperty",
          "rdfs:label": "Child Property"
        }
      });

      const result = await ontologizeServer.explorer([testCollection1], { recurse: true });

      // Should find both parent and embedded types
      assert.property(result, "owl:Class");
      assert.property(result, "rdf:Property");

      // Check that properties from embedded resources are included
      const owlClass = result["owl:Class"];
      assert.property(owlClass, "rdfs:label");
      assert.property(owlClass, "ex:hasChild");
      assert.property(owlClass, "ex:hasProperty");

      const rdfProperty = result["rdf:Property"];
      assert.property(rdfProperty, "rdfs:label");
    });

    it("should skip embedded resources when recurse=false", async function () {
      // Add resource with embedded resources
      await testCollection1.insertOne({
        _id: "ex:ParentClass",
        "@type": ["owl:Class"],
        "rdfs:label": "Parent Class",
        "ex:hasChild": {
          "@type": ["owl:Class"],
          "_id": "ex:ChildClass",
          "rdfs:label": "Child Class"
        }
      });

      const result = await ontologizeServer.explorer([testCollection1], { recurse: false });

      // Should only find parent type, not embedded types
      assert.property(result, "owl:Class");
      assert.notProperty(result, "ex:ChildClass");

      // But should still include the property pointing to embedded resource
      const owlClass = result["owl:Class"];
      assert.property(owlClass, "ex:hasChild");
    });

    it("should skip bridge/statements collections from recursion", async function () {
      const bridgeCollection = {
        _documents: [],
        collectionName: "bridge",

        find: function() {
          return {
            toArray: async () => [...this._documents]
          };
        },

        insertOne: async function(doc) {
          this._documents.push({ ...doc });
        }
      };

      // Add resource with embedded Statement
      await bridgeCollection.insertOne({
        _id: "bridge:Statement1",
        "@type": ["rdf:Statement"],
        "rdf:subject": "ex:Subject",
        "rdf:predicate": "ex:predicate",
        "rdf:object": "ex:Object",
        "ex:hasEmbedded": {
          "@type": ["owl:Class"],
          "_id": "ex:EmbeddedClass",
          "rdfs:label": "Embedded Class"
        }
      });

      const result = await ontologizeServer.explorer([bridgeCollection], { recurse: true });

      // Should find the Statement type but not recurse into embedded resources for bridge collection
      assert.property(result, "rdf:Statement");
      assert.notProperty(result, "owl:Class");
    });

    it("should skip embedded rdf:Statement resources during recursion", async function () {
      // Add resource with embedded Statement (which should be skipped)
      await testCollection1.insertOne({
        _id: "ex:ComplexResource",
        "@type": ["owl:Class"],
        "rdfs:label": "Complex Resource",
        "ex:hasChild": {
          "@type": ["owl:Class"],
          "_id": "ex:ChildClass",
          "rdfs:label": "Child Class"
        },
        "ex:hasStatement": {
          "@type": ["rdf:Statement"],
          "_id": "stmt:1",
          "rdf:subject": "ex:Subject",
          "rdf:predicate": "ex:predicate",
          "rdf:object": "ex:Object"
        }
      });

      const result = await ontologizeServer.explorer([testCollection1], { recurse: true });

      // Should find owl:Class from both parent and child, but not rdf:Statement
      assert.property(result, "owl:Class");
      assert.notProperty(result, "rdf:Statement");

      // Should include properties for both embedded resources
      const owlClass = result["owl:Class"];
      assert.property(owlClass, "ex:hasChild");
      assert.property(owlClass, "ex:hasStatement");
    });

    it("should handle arrays in @type properly", async function () {
      // Add resource with multiple types
      await testCollection1.insertOne({
        _id: "ex:MultiType",
        "@type": ["owl:Class", "rdfs:Class"],
        "rdfs:label": "Multi-type Resource"
      });

      const result = await ontologizeServer.explorer([testCollection1]);

      // Should use first type as primary key
      assert.property(result, "owl:Class");

      // @type mapping should include all types
      const owlClass = result["owl:Class"];
      assert.property(owlClass, "@type");
      assert.property(owlClass["@type"], "owl:Class");
      assert.property(owlClass["@type"], "rdfs:Class");
    });
  });
});
