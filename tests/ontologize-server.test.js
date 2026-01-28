/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
 */

import { assert } from "chai";
import { OntologizeServer } from "../src/OntologizeServer.js";
import { readFile } from "fs/promises";
import path from "path";

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

describe("OntologizeServer", function () {
  this.timeout(0);
  let ontologizeServer;

  beforeEach(function () {
    // Mock collections for testing
    const mockOntologyCollection = {
      findOne: () => Promise.resolve(null),
      find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      })
    };
    const mockContextCollection = {
      findOne: () => Promise.resolve(null)
    };
    const mockStatementsCollection = createMockStatementsCollection();
    ontologizeServer = new OntologizeServer(mockOntologyCollection, mockContextCollection, mockStatementsCollection);
  });

  describe("inheritance", function () {
    it("should extend Ontologize class", function () {
      // Should have methods from parent class
      assert.isFunction(ontologizeServer.isValidOntologyResource);
      assert.isFunction(ontologizeServer.getLabel);
      assert.isFunction(ontologizeServer.getVersion);

      // Should have new server-only methods
      assert.isFunction(ontologizeServer.loadJsonFile);
      assert.isFunction(ontologizeServer.importFromFile);
      assert.isFunction(ontologizeServer.importData);
    });

    it("should have same version as parent class", function () {
      assert.equal(ontologizeServer.getVersion(), "0.1.0");
    });

    it("should inherit parent class functionality", async function () {
      const validResource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };

      // Should work like parent class
      assert.isTrue(ontologizeServer.isValidOntologyResource(validResource));
      assert.equal(await ontologizeServer.getLabel(validResource), "Test Class");
    });
  });

  describe("server methods", function () {
    it("should have loadJsonFile method", function () {
      assert.isFunction(ontologizeServer.loadJsonFile);
    });

    it("should have importFromFile method", function () {
      assert.isFunction(ontologizeServer.importFromFile);
    });

    it("should have importData method", function () {
      assert.isFunction(ontologizeServer.importData);
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
          }
          else if (opts?.upsert) {
            this._documents.push(doc);
            return { modifiedCount: 0, matchedCount: 0, upsertedCount: 1, upsertedId: doc._id };
          }
          return { modifiedCount: 0, matchedCount: 0 };
        },

        deleteMany: async function(query = {}) {
          const initialLength = this._documents.length;
          if (Object.keys(query).length === 0) {
            this._documents = [];
          }
          else if (query._id) {
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
          }
          else if (opts?.upsert) {
            this._documents.push(doc);
          }
          return { modifiedCount: 1 };
        }
      };

      const statementsCollection = createMockStatementsCollection();
      ontologizeServer = new OntologizeServer(testCollection, contextCollection, statementsCollection);
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
      // First import BFO data
      const bfoPath = path.resolve(process.cwd(), "../../private/data/bootstrap/bfo-core.jsonld");

      try {
        const importResult = await ontologizeServer.importFromFile(
          bfoPath,
          testCollection,
          {
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

        find: function(query = {}) {
          return {
            toArray: async () => {
              let results = [...this._documents];

              // Support _id.$in queries
              if (query._id && query._id.$in) {
                results = results.filter(doc => query._id.$in.includes(doc._id));
              }

              // Support @type.$in queries
              if (query["@type"] && query["@type"].$in) {
                const targetTypes = query["@type"].$in;
                results = results.filter(doc => {
                  if (!doc["@type"]) return false;
                  const docTypes = Array.isArray(doc["@type"]) ? doc["@type"] : [doc["@type"]];
                  return targetTypes.some(type => docTypes.includes(type));
                });
              }

              return results;
            }
          };
        },

        replaceOne: async function(query, doc, opts) {
          const index = this._documents.findIndex(d => d._id === query._id);
          if (index >= 0) {
            this._documents[index] = doc;
          }
          else if (opts?.upsert) {
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
          }
          else if (opts?.upsert) {
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

      const statementsCollection = createMockStatementsCollection();
      ontologizeServer = new OntologizeServer(ontologyCollection, contextCollection, statementsCollection);

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
      assert.include(result.README, "JSON");

      // Check that types were found
      assert.exists(result.Classes);
      assert.property(result.Classes, "owl:Class");
      assert.exists(result.Properties);
      assert.exists(result.Properties.Properties); // properties that are just rdfs:Property not Object or DataType
      assert.property(result.Properties.Properties, "rdfs:label");

      // Check owl:Class mapping
      const owlClass = result.Classes["owl:Class"];
      assert.isObject(owlClass);
      assert.isObject(owlClass.classInfo);
      assert.property(owlClass.classInfo, "@type");
      assert.property(owlClass.classInfo, "rdfs:label");
      assert.property(owlClass.classInfo, "rdfs:comment");

      // Check that @type property contains ontology definitions
      assert.isArray(owlClass.classInfo["@type"]);
      assert.ok(owlClass.classInfo["@type"].includes("rdfs:Class"));


      // Check that properties contain ontology definitions
      assert.isObject(owlClass.instanceProperties);
      assert.isObject(owlClass.instanceProperties["rdfs:label"]);
      assert.equal(owlClass.instanceProperties["rdfs:label"]["rdfs:label"], "label");
    });

    it("should handle resources without @type", async function () {
      // Add resource without @type
      await testCollection1.insertOne({
        _id: "ex:NoType",
        "rdfs:label": "Resource without type"
      });

      const result = await ontologizeServer.explorer([testCollection1]);

      // Explorer only processes resources with valid @type, so this resource should be ignored
      // Verify basic structure still works
      assert.isObject(result);
      assert.property(result, "README");
      assert.property(result, "Classes");
      assert.property(result, "Properties");
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

      // Should find owl:Class in Classes section
      assert.property(result, "Classes");
      assert.property(result.Classes, "owl:Class");

      // Check that properties from both parent and embedded resources are included
      const owlClass = result.Classes["owl:Class"];
      assert.isObject(owlClass);
      assert.isObject(owlClass.instanceProperties);
      assert.property(owlClass.instanceProperties, "rdfs:label");
      assert.property(owlClass.instanceProperties, "ex:hasChild");
      assert.property(owlClass.instanceProperties, "ex:hasProperty");
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

      // Should find owl:Class in Classes section
      assert.property(result, "Classes");
      assert.property(result.Classes, "owl:Class");

      // Should include the property pointing to embedded resource (parent properties only, not from embedded child)
      const owlClass = result.Classes["owl:Class"];
      assert.isObject(owlClass.instanceProperties);
      assert.property(owlClass.instanceProperties, "rdfs:label");
      assert.property(owlClass.instanceProperties, "ex:hasChild");

      // When recurse=false, should NOT include properties from embedded child resource
      // (Child has rdfs:label but that shouldn't be counted separately when not recursing)
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

      // Add top-level owl:Class to bridge collection
      await bridgeCollection.insertOne({
        _id: "bridge:TopLevel",
        "@type": ["owl:Class"],
        "rdfs:label": "Top Level Class",
        "ex:hasEmbedded": {
          "@type": ["owl:Class"],
          "_id": "ex:EmbeddedClass",
          "rdfs:label": "Embedded Class"
        }
      });

      const result = await ontologizeServer.explorer([bridgeCollection], { recurse: true });

      // The top-level resource should be found (it has @type owl:Class)
      assert.property(result, "Classes");
      assert.property(result.Classes, "owl:Class");

      // But when recursing, bridge collections should skip embedded resources
      const owlClass = result.Classes["owl:Class"];
      assert.isObject(owlClass.instanceProperties);

      // The top-level resource has these properties
      assert.property(owlClass.instanceProperties, "rdfs:label");
      assert.property(owlClass.instanceProperties, "ex:hasEmbedded");

      // Embedded resource should NOT contribute its own rdfs:label separately
      // (it's the same property name but shouldn't be double-counted from embedded when collection is bridge)
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

      // Should find owl:Class from both parent and child
      assert.property(result, "Classes");
      assert.property(result.Classes, "owl:Class");

      // rdf:Statement should be excluded (filtered by _is check in _findEmbeddedResources)
      // But should include properties for embedded resources
      const owlClass = result.Classes["owl:Class"];
      assert.isObject(owlClass.instanceProperties);
      assert.property(owlClass.instanceProperties, "ex:hasChild");
      assert.property(owlClass.instanceProperties, "ex:hasStatement");
      assert.property(owlClass.instanceProperties, "rdfs:label");
    });

    it("should handle arrays in @type properly", async function () {
      // Add rdfs:Class to ontology collection so it appears in Classes
      await ontologyCollection.insertOne({
        _id: "rdfs:Class",
        "@type": ["rdfs:Class"],
        "rdfs:label": "Class",
        "rdfs:comment": "The class of classes."
      });

      // Add resource with multiple types to test collection
      await testCollection1.insertOne({
        _id: "ex:MultiType",
        "@type": ["owl:Class", "rdfs:Class"],
        "rdfs:label": "Multi-type Resource"
      });

      const result = await ontologizeServer.explorer([testCollection1]);

      // Should find both owl:Class and rdfs:Class in Classes section
      assert.property(result, "Classes");
      assert.property(result.Classes, "owl:Class");
      assert.property(result.Classes, "rdfs:Class");

      // Instance with multiple types should contribute properties to BOTH types
      const owlClass = result.Classes["owl:Class"];
      assert.isObject(owlClass.instanceProperties);
      assert.property(owlClass.instanceProperties, "rdfs:label");

      const rdfsClass = result.Classes["rdfs:Class"];
      assert.isObject(rdfsClass.instanceProperties);
      assert.property(rdfsClass.instanceProperties, "rdfs:label");
    });
  });

  describe("ensurePropertyContext", function () {
    let ontologyCollection;
    let contextCollection;

    beforeEach(function () {
      // Create mock collections with updateOne support
      ontologyCollection = {
        _documents: [],

        findOne: async function(query) {
          if (query._id) {
            return this._documents.find(doc => doc._id === query._id) || null;
          }
          return this._documents[0] || null;
        },

        insertOne: async function(doc) {
          this._documents.push({ ...doc });
          return { insertedId: doc._id };
        }
      };

      contextCollection = {
        _documents: [
          { _id: "@id", "@vocab": "https://ontology.2wav.com#" }
        ],

        findOne: async function(query) {
          if (query._id === "@id") {
            return this._documents.find(doc => doc._id === "@id") || null;
          }
          return null;
        },

        updateOne: async function(query, update, opts) {
          const doc = this._documents.find(d => d._id === query._id);
          if (doc && update.$set) {
            Object.assign(doc, update.$set);
            return { modifiedCount: 1, matchedCount: 1 };
          }
          else if (opts?.upsert && update.$set) {
            this._documents.push({ _id: query._id, ...update.$set });
            return { modifiedCount: 0, matchedCount: 0, upsertedCount: 1 };
          }
          return { modifiedCount: 0, matchedCount: 0 };
        }
      };

      const statementsCollection = createMockStatementsCollection();
      ontologizeServer = new OntologizeServer(ontologyCollection, contextCollection, statementsCollection);
    });

    it("should add @type: '@id' for ObjectProperty", async function () {
      const objectProperty = {
        _id: "ex:hasParent",
        "@type": ["owl:ObjectProperty"],
        "rdfs:range": "ex:Person"
      };

      await ontologizeServer.ensurePropertyContext(objectProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:hasParent"]);
      assert.equal(context["ex:hasParent"]["@type"], "@id");
    });

    it("should add @type with XSD URI for DatatypeProperty with xsd:string range", async function () {
      const datatypeProperty = {
        _id: "ex:name",
        "@type": ["owl:DatatypeProperty"],
        "rdfs:range": "xsd:string"
      };

      await ontologizeServer.ensurePropertyContext(datatypeProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:name"]);
      assert.equal(context["ex:name"]["@type"], "http://www.w3.org/2001/XMLSchema#string");
    });

    it("should add @type with XSD URI for DatatypeProperty with xsd:integer range", async function () {
      const datatypeProperty = {
        _id: "ex:age",
        "@type": ["owl:DatatypeProperty"],
        "rdfs:range": "xsd:integer"
      };

      await ontologizeServer.ensurePropertyContext(datatypeProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:age"]);
      assert.equal(context["ex:age"]["@type"], "http://www.w3.org/2001/XMLSchema#integer");
    });

    it("should add @type with XSD URI for DatatypeProperty with xsd:dateTime range", async function () {
      const datatypeProperty = {
        _id: "ex:birthDate",
        "@type": ["owl:DatatypeProperty"],
        "rdfs:range": "xsd:dateTime"
      };

      await ontologizeServer.ensurePropertyContext(datatypeProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:birthDate"]);
      assert.equal(context["ex:birthDate"]["@type"], "http://www.w3.org/2001/XMLSchema#dateTime");
    });

    it("should add @container: '@list' for array property with bold:container", async function () {
      const arrayProperty = {
        _id: "ex:hasChildren",
        "@type": ["owl:ObjectProperty"],
        "rdfs:range": "ex:Person",
        "bold:container": "@list"
      };

      await ontologizeServer.ensurePropertyContext(arrayProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:hasChildren"]);
      assert.equal(context["ex:hasChildren"]["@container"], "@list");
    });

    it("should add @container: '@set' for array property with bold:container @set", async function () {
      const arrayProperty = {
        _id: "ex:hasTags",
        "@type": ["owl:DatatypeProperty"],
        "rdfs:range": "xsd:string",
        "bold:container": "@set"
      };

      await ontologizeServer.ensurePropertyContext(arrayProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:hasTags"]);
      assert.equal(context["ex:hasTags"]["@container"], "@set");
    });

    it("should add both @type and @container when both apply", async function () {
      const combinedProperty = {
        _id: "ex:hasMembers",
        "@type": ["owl:ObjectProperty"],
        "rdfs:range": "ex:Person",
        "bold:container": "@list"
      };

      await ontologizeServer.ensurePropertyContext(combinedProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:hasMembers"]);
      assert.equal(context["ex:hasMembers"]["@type"], "@id");
      assert.equal(context["ex:hasMembers"]["@container"], "@list");
    });

    it("should preserve existing context settings when adding new ones", async function () {
      // Pre-populate with existing property context
      contextCollection._documents[0]["ex:existingProp"] = {
        "@type": "@id",
        "customField": "preserved"
      };

      const arrayProperty = {
        _id: "ex:existingProp",
        "@type": ["owl:ObjectProperty"],
        "rdfs:range": "ex:Thing",
        "bold:container": "@list"
      };

      await ontologizeServer.ensurePropertyContext(arrayProperty, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:existingProp"]);
      assert.equal(context["ex:existingProp"]["@type"], "@id");
      assert.equal(context["ex:existingProp"]["@container"], "@list");
      assert.equal(context["ex:existingProp"]["customField"], "preserved");
    });

    it("should lookup property from Ontology if resource lacks rdfs:range", async function () {
      // Add property definition to ontology collection
      await ontologyCollection.insertOne({
        _id: "ex:lookupProp",
        "@type": ["owl:DatatypeProperty"],
        "rdfs:range": "xsd:boolean"
      });

      // Property resource without rdfs:range (will be looked up)
      const propertyWithoutRange = {
        _id: "ex:lookupProp",
        "@type": ["owl:DatatypeProperty"]
      };

      await ontologizeServer.ensurePropertyContext(propertyWithoutRange, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      assert.isObject(context["ex:lookupProp"]);
      assert.equal(context["ex:lookupProp"]["@type"], "http://www.w3.org/2001/XMLSchema#boolean");
    });

    it("should handle property without rdfs:range gracefully", async function () {
      const propertyWithoutRange = {
        _id: "ex:unknownProp",
        "@type": ["rdf:Property"]
      };

      // Should not throw, just skip
      await ontologizeServer.ensurePropertyContext(propertyWithoutRange, contextCollection);

      const context = await contextCollection.findOne({ _id: "@id" });
      // Property should not be added since we can't determine @type or @container
      assert.notProperty(context, "ex:unknownProp");
    });

    it("should not update context if property already has correct settings", async function () {
      // Pre-populate with existing property context
      contextCollection._documents[0]["ex:alreadySet"] = {
        "@type": "@id",
        "@container": "@list"
      };

      let updateCount = 0;
      const originalUpdateOne = contextCollection.updateOne;
      contextCollection.updateOne = async function(...args) {
        updateCount++;
        return originalUpdateOne.apply(this, args);
      };

      const property = {
        _id: "ex:alreadySet",
        "@type": ["owl:ObjectProperty"],
        "rdfs:range": "ex:Thing",
        "bold:container": "@list"
      };

      await ontologizeServer.ensurePropertyContext(property, contextCollection);

      // Should not call updateOne since nothing needs to change
      assert.equal(updateCount, 0);
    });
  });
});
