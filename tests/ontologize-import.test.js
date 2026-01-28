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
import { join } from "path";

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

describe("OntologizeServer Import", function () {
  this.timeout(0); // turn off timeout for debugging
  let ontologizeServer;
  let mockOntologyCollection;
  let mockContextCollection;
  let mockStatementsCollection;
  let ontologyData = [];
  let contextData = {};

  beforeEach(function () {
    // Mock collections
    ontologyData = [];
    contextData = {};

    mockOntologyCollection = {
      deleteMany: async () => {
        const deletedCount = ontologyData.length;
        ontologyData.length = 0;
        return { deletedCount };
      },
      replaceOne: async (filter, doc, opts) => {
        const index = ontologyData.findIndex(item => item._id === filter._id);
        if (index >= 0) {
          ontologyData[index] = doc;
        }
        else {
          ontologyData.push(doc);
        }
        return { acknowledged: true, matchedCount: index >= 0 ? 1 : 0, modifiedCount: 1, upsertedId: null };
      },
      find: (query = {}) => ({
        toArray: async () => {
          let results = [...ontologyData];

          // Handle _id.$in queries
          if (query._id && query._id.$in) {
            results = results.filter(item => query._id.$in.includes(item._id));
          }
          // Handle @type.$in queries
          else if (query["@type"] && query["@type"].$in) {
            const targetTypes = query["@type"].$in;
            results = results.filter(item => {
              if (!item["@type"]) return false;
              const itemTypes = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
              return targetTypes.some(type => itemTypes.includes(type));
            });
          }
          // Simple equality check for other queries
          else if (Object.keys(query).length > 0) {
            results = results.filter(item => {
              return Object.keys(query).every(key => item[key] === query[key]);
            });
          }

          return results;
        }
      }),
      findOne: async (filter) => {
        return ontologyData.find(item => {
          return Object.keys(filter).every(key => item[key] === filter[key]);
        }) || null;
      }
    };

    mockContextCollection = {
      deleteMany: async () => {
        const wasEmpty = Object.keys(contextData).length === 0;
        contextData = {};
        return { deletedCount: wasEmpty ? 0 : 1 };
      },
      replaceOne: async (filter, doc, opts) => {
        contextData = doc;
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
      },
      findOne: async (filter) => {
        if (filter._id === "@id") {
          // Return null if contextData is truly empty (not even _id set)
          // But return contextData if it has _id: "@id" (even if no other keys)
          return (Object.keys(contextData).length === 0 || !contextData._id) ? null : contextData;
        }
        return null;
      }
    };

    mockStatementsCollection = createMockStatementsCollection();

    // Create the ontologize server instance with the mock collections
    ontologizeServer = new OntologizeServer(mockOntologyCollection, mockContextCollection, mockStatementsCollection);
  });

  describe("importFromFile", function () {
    it("should exist as a method", function () {
      assert.isFunction(ontologizeServer.importFromFile);
    });

    it("should import simple ontology array", async function () {
      // TODO SURPRISE PROBLEM that might need to be addressed in Ld.
      // jsonld does not expand @id by the @vocab, even in the most recent online playground
      const exInput = {
        "@id": "TestClass",
        "@type": "rdfs:Class",
        "rdfs:label": "Test Class",
        "foo":"bar",
        "@context": {
          "@vocab": "http://example.org/",
          "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
        }
      };
      // jsonld expands to
      const exExpanded = [
        {
          "@id": "TestClass",
          "@type": [
            "http://www.w3.org/2000/01/rdf-schema#Class"
          ],
          "http://example.org/foo": [
            {
              "@value": "bar"
            }
          ],
          "http://www.w3.org/2000/01/rdf-schema#label": [
            {
              "@value": "Test Class"
            }
          ]
        }
      ];

      // Create test data
      const testData = [
        {
          "@id": "@context",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
            "ex": "http://example.org/"
          }
        },
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class",
          "foo": "bar", // should normalize to "ex:foo"
        },
        {
          "@id": "ex:testProperty",
          "@type": "owl:ObjectProperty",
          "rdfs:label": "Test Property"
        }
      ];

      // Mock file loading
      ontologizeServer.loadJsonFile = async (filePath) => testData;

      const result = await ontologizeServer.importFromFile(
        "test.json",
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.isTrue(result.contextImported);
      assert.equal(result.processedResources, 2);
      assert.equal(result.totalResources, 2);

      // Check context was imported
      const contextData = await ontologizeServer.getContext();
      assert.equal(contextData._id, "@id");
      assert.equal(contextData["ex"], "http://example.org/");

      // Check resources were imported
      assert.equal(ontologyData.length, 2);
      assert.isTrue(ontologyData.some(r => r._id === "ex:TestClass"));
      assert.isTrue(ontologyData.some(r => r._id === "ex:testProperty"));
      assert.isTrue(ontologyData.some(r => r["ex:foo"] !== undefined));
    });

    it("should handle @graph format", async function () {
      const testData = {
        "@context": {
          "@vocab": "http://example.org/",
          "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
          "ex": "http://example.org/"
        },
        "@graph": [
          {
            "@id": "ex:TestClass",
            "@type": "rdfs:Class",
            "rdfs:label": "Test Class",
            "foo": "bar", // should normalize to "ex:foo"
          }
        ]
      };

      ontologizeServer.loadJsonFile = async (filePath) => testData;

      const result = await ontologizeServer.importFromFile(
        "test.json",
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      const contextData = await ontologizeServer.getContext();
      assert.equal(contextData._id, "@id");
      assert.equal(contextData["ex"], "http://example.org/");
    });

    it("should handle clearCollection option", async function () {
      // Pre-populate collections
      ontologyData.push({ _id: "existing", data: "old" });
      contextData = { _id: "@id" };

      const testData = [
        {
          "@id": "@context",
          "@context": {
            "ex": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
          }
        },
        {
          "@id": "ex:NewClass",
          "@type": "rdfs:Class"
        }
      ];

      ontologizeServer.loadJsonFile = async (filePath) => testData;

      const result = await ontologizeServer.importFromFile(
        "test.json",
        mockOntologyCollection,
        { clearCollection: true }
      );

      assert.isTrue(result.success);
      assert.equal(ontologyData.length, 1);
      assert.equal(ontologyData[0]._id, "ex:NewClass");
    });
  });

  describe("_isTBoxResource", function () {
    it("should identify owl:Class as TBox resource", function () {
      const resource = {
        "_id": "ex:TestClass",
        "@type": "owl:Class"
      };

      assert.isTrue(ontologizeServer._isTBoxResource(resource));
    });

    it("should identify rdfs:Class as TBox resource", function () {
      const resource = {
        "_id": "ex:TestClass",
        "@type": "rdfs:Class"
      };

      assert.isTrue(ontologizeServer._isTBoxResource(resource));
    });

    it("should identify owl:ObjectProperty as TBox resource", function () {
      const resource = {
        "_id": "ex:testProperty",
        "@type": "owl:ObjectProperty"
      };

      assert.isTrue(ontologizeServer._isTBoxResource(resource));
    });

    it("should identify multiple types including TBox", function () {
      const resource = {
        "_id": "ex:TestClass",
        "@type": ["owl:Class", "ex:SpecialClass"]
      };

      assert.isTrue(ontologizeServer._isTBoxResource(resource));
    });

    it("should not identify regular resources as TBox", function () {
      const resource = {
        "_id": "ex:instance",
        "@type": "ex:Person"
      };

      assert.isFalse(ontologizeServer._isTBoxResource(resource));
    });

    it("should handle resources without @type", function () {
      const resource = {
        "_id": "ex:instance",
        "rdfs:label": "Test"
      };

      assert.isFalse(ontologizeServer._isTBoxResource(resource));
    });
  });

  describe("real file import", function () {
    it("should import actual ontology.json file", async function () {
      const cwd = process.cwd();
      const filePath = "./tests/data/ontology.json";

      // Test loading the file
      let fileData;
      try {
        fileData = await ontologizeServer.loadJsonFile(filePath);
      }
      catch (error) {
        // Skip test if file doesn't exist
        this.skip("ontology.json file not found");
        return;
      }

      assert.isArray(fileData);
      assert.isTrue(fileData.length > 0);

      // First element should be context
      const firstElement = fileData[0];
      assert.equal(firstElement._id, "@context");
      assert.isObject(firstElement["@context"]);

      // Should have ontology resources
      const ontologyResources = fileData.slice(1);
      assert.isTrue(ontologyResources.length > 0);

      // Test actual import
      const result = await ontologizeServer.importFromFile(
        filePath,
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.isTrue(result.contextImported);
      assert.isTrue(result.processedResources > 0);

      // Check that context was imported
      assert.equal(contextData._id, "@id");
      assert.isString(contextData["@vocab"]);

      // Check that ontology resources were imported
      assert.isTrue(ontologyData.length > 0);

      // bold resources have been moved into bold.jsonld
      // so this is obsolete
      // const ctbClasses = ontologyData.filter(r =>
      //   r._id && r._id.startsWith("bold:") &&
      //   (r["@type"] === "rdfs:Class" || (Array.isArray(r["@type"]) && r["@type"].includes("rdfs:Class")))
      // );
      // assert.isTrue(ctbClasses.length > 0);

      console.log(`Imported ${result.processedResources} resources from ${result.totalResources} total`);
      // console.log(`Found ${ctbClasses.length} CTB classes`);
    });
  });

  describe("New Import Methods", function () {
    it("should have importFromFile method", function () {
      assert.isFunction(ontologizeServer.importFromFile);
    });

    it("should have importOntologyData method", function () {
      assert.isFunction(ontologizeServer.importOntologyData);
    });

    it("should import from array using importOntologyData", async function () {
      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        },
        {
          "@id": "ex:Instance",
          "@type": "ex:Person",
          "rdfs:label": "Test Instance"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.equal(result.inputSource, "object");
      assert.equal(result.totalResources, 2);
      assert.equal(result.processedResources, 2);
      assert.equal(result.tboxResources, 1);
      assert.equal(result.aboxResources, 1);
    });

    it("should normalize @type to array", async function () {
      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        { ensureArrayTypes: true }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);

      // Check that @type was converted to array
      const savedResource = ontologyData[0];
      assert.isArray(savedResource["@type"]);
      assert.equal(savedResource["@type"][0], "rdfs:Class");
    });

    it("should handle clearCollection option", async function () {
      // Pre-populate collections
      ontologyData.push({ _id: "existing", data: "old" });
      contextData = { _id: "@id" };

      const testData = [
        {
          "_id": "ex:NewClass",
          "@type": "rdfs:Class"
        }
      ];
      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        { clearCollection: true }
      );

      assert.isTrue(result.success);
      assert.equal(ontologyData.length, 1);
      assert.equal(ontologyData[0]._id, "ex:NewClass");
      assert.isArray(ontologyData[0]["@type"]);
      assert.equal(ontologyData[0]["@type"][0], "rdfs:Class");
    });

    it("should provide detailed error information", async function () {
      const testData = [
        {
          // Missing _id should cause error
          "@type": "rdfs:Class",
          "rdfs:label": "Invalid Resource"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.equal(result.errors.length, 1);
      assert.include(result.errors[0].error.toLowerCase(), "resource");
    });

    it("should work without normalization", async function () {
      const testData = [
        {
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        { normalize: false }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);
    });

    it("should handle custom context", async function () {
      const customContext = {
        "@vocab": "http://custom.org/",
        "_id": "@id",
        "test": "http://test.org/"
      };

      const testData = [
        {
          "_id": "test:CustomClass",
          "@type": "rdfs:Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        { context: customContext }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);
    });
  });

  describe("Context Merge Strategy", function () {
    it("should merge contexts without conflicts", async function () {
      // First import with initial context
      const firstData = [
        {
          "_id": "ex:data1",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
            "_id": "@id"
          }
        }
      ];

      ontologizeServer.loadJsonFile = async (filePath) => firstData;
      await ontologizeServer.importFromFile("first.json", mockOntologyCollection);

      // Second import with additional context
      const secondData = [
        {
          "@id": "data2",
          "@context": {
            "owl": "http://www.w3.org/2002/07/owl#",
            "dc": "http://purl.org/dc/elements/1.1/"
          }
        }
      ];

      ontologizeServer.loadJsonFile = async (filePath) => secondData;
      await ontologizeServer.importFromFile("second.json", mockOntologyCollection);

      // Check that both contexts were merged
      // incoming @vocab can't override default @vocab
      // assert.equal(contextData["@vocab"], "http://example.org/");
      assert.equal(contextData["rdfs"], "http://www.w3.org/2000/01/rdf-schema#");
      assert.equal(contextData["owl"], "http://www.w3.org/2002/07/owl#");
      assert.equal(contextData["dc"], "http://purl.org/dc/elements/1.1/");
    });

    it("should merge multiple contexts in single array", async function () {
      // Import data with multiple context items in the same array
      const multiContextData = [
        {
          "@id": "first-context",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
          }
        },
        {
          "@id": "second-context",
          "@context": {
            "owl": "http://www.w3.org/2002/07/owl#",
            "dc": "http://purl.org/dc/elements/1.1/"
          }
        },
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      ontologizeServer.loadJsonFile = async (filePath) => multiContextData;
      const result = await ontologizeServer.importFromFile("multi.json", mockOntologyCollection);

      assert.isTrue(result.success);
      assert.isTrue(result.contextImported);
      assert.equal(result.totalResources, 1); // Only the TestClass should be counted as resource
      assert.equal(result.processedResources, 1);

      // Check that both contexts were merged
      // but not @vocab!
      // assert.equal(contextData["@vocab"], "http://example.org/");
      assert.equal(contextData["rdfs"], "http://www.w3.org/2000/01/rdf-schema#");
      assert.equal(contextData["owl"], "http://www.w3.org/2002/07/owl#");
      assert.equal(contextData["dc"], "http://purl.org/dc/elements/1.1/");

      // Check that the resource was imported
      assert.equal(ontologyData.length, 1);
      assert.equal(ontologyData[0]._id, "ex:TestClass");
    });

    it("should handle context key sorting", async function () {
      const testData = [
        {
          "@id": "@context",
          "@context": {
            "zprefix": "http://z.example.org/",
            "@vocab": "http://example.org/",
            "aprefix": "http://a.example.org/",
            "@base": "http://base.example.org/",
            "rdfs:subClassOf": {"@type": "@id"}
          }
        }
      ];

      ontologizeServer.loadJsonFile = async (filePath) => testData;
      await ontologizeServer.importFromFile("test.json", mockOntologyCollection);

      // Check that keys are properly sorted (excluding _id)
      const allKeys = Object.keys(contextData);
      const keys = allKeys.filter(k => k !== "_id");
      const atKeys = keys.filter(k => k.startsWith("@"));
      const namespaceKeys = keys.filter(k => !k.startsWith("@") && !k.includes(":"));
      const prefixedKeys = keys.filter(k => !k.startsWith("@") && k.includes(":"));

      // @-keys should come first
      assert.isTrue(atKeys.every(atKey =>
        namespaceKeys.every(nsKey => keys.indexOf(atKey) < keys.indexOf(nsKey))
      ));

      // Namespace keys should come before prefixed keys
      assert.isTrue(namespaceKeys.every(nsKey =>
        prefixedKeys.every(prefixKey => keys.indexOf(nsKey) < keys.indexOf(prefixKey))
      ));
    });
  });

  describe("BOLD Resource Normalization", function () {
    it("should ensure @type is array after import", async function () {

      // Test with actual ontology if available
      const filePath = "../../private/data/bootstrap/ontology.json";

      let fileData;
      try {
        fileData = await ontologizeServer.loadJsonFile(filePath);
      }
      catch (error) {
        this.skip("ontology.json file not found");
        return;
      }

      // Import with BOLD normalization
      const result = await ontologizeServer.importFromFile(
        filePath,
        mockOntologyCollection,
        {
          normalize: true,
          ensureArrayTypes: true,
          clearCollection: true
        }
      );

      assert.isTrue(result.success);
      assert.isTrue(result.processedResources > 0);

      // Check that all resources have @type as array
      const resourcesWithTypes = ontologyData.filter(r => r["@type"]);
      assert.isTrue(resourcesWithTypes.length > 0);

      for (const resource of resourcesWithTypes) {
        assert.isArray(resource["@type"], `Resource ${resource._id} should have @type as array`);
      }

      console.log(`Normalized ${result.processedResources} resources`);
      console.log(`TBox resources: ${result.tboxResources}`);
      console.log(`ABox resources: ${result.aboxResources}`);
      if (result.errors.length > 0) {
        console.log(`Errors: ${result.errors.length}`);
      }
    });
  });

  describe("TBox Resource Merge Strategy", function () {
    it("should merge TBox resources with existing resources", async function () {
      // First import a TBox resource
      const firstData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class",
          "rdfs:comment": "Initial comment"
        }
      ];

      const result1 = await ontologizeServer.importOntologyData(
        firstData,
        mockOntologyCollection
      );

      assert.isTrue(result1.success);
      assert.equal(result1.processedResources, 1);
      assert.equal(result1.tboxResources, 1);

      // Second import with additional properties for the same resource
      const secondData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Updated Test Class",
          "rdfs:subClassOf": "ex:ParentClass",
          "ex:newProperty": "added value"
        }
      ];

      const result2 = await ontologizeServer.importOntologyData(
        secondData,
        mockOntologyCollection
      );

      assert.isTrue(result2.success);
      assert.equal(result2.processedResources, 1);
      assert.equal(result2.tboxResources, 1);

      // Check that the resource was merged, not replaced
      const finalResource = ontologyData.find(r => r._id === "ex:TestClass");
      assert.isObject(finalResource);

      // Should have the updated label
      assert.equal(finalResource["rdfs:label"], "Updated Test Class");

      // Should keep the original comment
      assert.equal(finalResource["rdfs:comment"], "Initial comment");

      // Should have the new properties
      assert.equal(finalResource["rdfs:subClassOf"], "ex:ParentClass");
      assert.equal(finalResource["ex:newProperty"], "added value");
    });

    it("should merge array properties using union", async function () {
      // First import with array property
      const firstData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:seeAlso": ["ex:RelatedClass1", "ex:RelatedClass2"]
        }
      ];

      await ontologizeServer.importOntologyData(firstData, mockOntologyCollection);

      // Second import with additional array items
      const secondData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:seeAlso": ["ex:RelatedClass2", "ex:RelatedClass3"] // Note: RelatedClass2 is duplicate
        }
      ];

      await ontologizeServer.importOntologyData(secondData, mockOntologyCollection);

      // Check that arrays were merged using union (no duplicates)
      const finalResource = ontologyData.find(r => r._id === "ex:TestClass");
      assert.isArray(finalResource["rdfs:seeAlso"]);
      assert.equal(finalResource["rdfs:seeAlso"].length, 3);
      assert.isTrue(finalResource["rdfs:seeAlso"].includes("ex:RelatedClass1"));
      assert.isTrue(finalResource["rdfs:seeAlso"].includes("ex:RelatedClass2"));
      assert.isTrue(finalResource["rdfs:seeAlso"].includes("ex:RelatedClass3"));
    });

    it("should respect mergeOntology=false option", async function () {
      // First import
      const firstData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Original Label",
          "rdfs:comment": "Original comment"
        }
      ];

      await ontologizeServer.importOntologyData(firstData, mockOntologyCollection);

      // Second import with mergeOntology=false
      const secondData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Replaced Label"
        }
      ];

      await ontologizeServer.importOntologyData(
        secondData,
        mockOntologyCollection,
        { mergeOntology: false }
      );

      // Check that resource was replaced, not merged
      const finalResource = ontologyData.find(r => r._id === "ex:TestClass");
      assert.equal(finalResource["rdfs:label"], "Replaced Label");
      assert.isUndefined(finalResource["rdfs:comment"]); // Should be gone
    });
  });

  describe("beforeSaveFn Callback", function () {
    it("should call beforeSaveFn with normalized resource", async function () {
      const capturedResources = [];

      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        {
          beforeSaveFn: (resource) => {
            capturedResources.push({ ...resource });
            return resource;
          }
        }
      );

      assert.isTrue(result.success);
      assert.equal(capturedResources.length, 1);
      assert.equal(capturedResources[0]._id, "ex:TestClass");
      assert.isArray(capturedResources[0]["@type"]);
    });

    it("should allow sync beforeSaveFn to modify resource", async function () {
      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Original Label"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        {
          beforeSaveFn: (resource) => {
            // Add a property to the resource
            return {
              ...resource,
              "ex:addedProperty": "added-value",
              "rdfs:label": "Modified Label"
            };
          }
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);

      const savedResource = ontologyData.find(r => r._id === "ex:TestClass");
      assert.equal(savedResource["ex:addedProperty"], "added-value");
      assert.equal(savedResource["rdfs:label"], "Modified Label");
    });

    it("should allow async beforeSaveFn to modify resource", async function () {
      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        {
          beforeSaveFn: async (resource) => {
            // Simulate async operation
            await new Promise(resolve => setTimeout(resolve, 10));
            return {
              ...resource,
              "ex:asyncProperty": "async-value"
            };
          }
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);

      const savedResource = ontologyData.find(r => r._id === "ex:TestClass");
      assert.equal(savedResource["ex:asyncProperty"], "async-value");
    });

    it("should skip resource when beforeSaveFn returns false", async function () {
      const testData = [
        {
          "@id": "ex:SkippedClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Should be skipped"
        },
        {
          "@id": "ex:SavedClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Should be saved"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        {
          beforeSaveFn: (resource) => {
            // Skip resources with "Skipped" in the ID
            if (resource._id.includes("Skipped")) {
              return false;
            }
            return resource;
          }
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);
      assert.equal(result.skippedResources, 1);
      assert.equal(result.totalResources, 2);

      // Verify skipped resource was not saved
      const skippedResource = ontologyData.find(r => r._id === "ex:SkippedClass");
      assert.isUndefined(skippedResource);

      // Verify saved resource was saved
      const savedResource = ontologyData.find(r => r._id === "ex:SavedClass");
      assert.isObject(savedResource);
    });

    it("should skip resource when beforeSaveFn returns null", async function () {
      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        {
          beforeSaveFn: () => null
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 0);
      assert.equal(result.skippedResources, 1);
      assert.equal(ontologyData.length, 0);
    });

    it("should skip resource when beforeSaveFn returns undefined", async function () {
      const testData = [
        {
          "@id": "ex:TestClass",
          "@type": "rdfs:Class"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        {
          beforeSaveFn: () => undefined
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 0);
      assert.equal(result.skippedResources, 1);
    });

    it("should filter ABox resources by type using beforeSaveFn", async function () {
      // Create a mock ABox collection
      const aboxData = [];
      const mockAboxCollection = {
        deleteMany: async () => {
          aboxData.length = 0;
          return { deletedCount: 0 };
        },
        replaceOne: async (filter, doc) => {
          const index = aboxData.findIndex(item => item._id === filter._id);
          if (index >= 0) {
            aboxData[index] = doc;
          }
          else {
            aboxData.push(doc);
          }
          return { acknowledged: true };
        }
      };

      const testData = [
        {
          "@id": "ex:person1",
          "@type": "foaf:Person",
          "foaf:name": "John"
        },
        {
          "@id": "ex:org1",
          "@type": "org:Organization",
          "rdfs:label": "ACME"
        },
        {
          "@id": "ex:person2",
          "@type": "foaf:Person",
          "foaf:name": "Jane"
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockAboxCollection,
        {
          beforeSaveFn: (resource) => {
            // Only save foaf:Person resources
            const types = Array.isArray(resource["@type"]) ? resource["@type"] : [resource["@type"]];
            if (types.includes("foaf:Person")) {
              return resource;
            }
            return false;
          }
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 2);
      assert.equal(result.skippedResources, 1);
      assert.equal(aboxData.length, 2);
      assert.isTrue(aboxData.every(r => r["@type"].includes("foaf:Person")));
    });

    it("should work with importFromFile", async function () {
      const testData = {
        "@context": {
          "ex": "http://example.org/",
          "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
        },
        "@graph": [
          {
            "@id": "ex:Class1",
            "@type": "rdfs:Class"
          },
          {
            "@id": "ex:Class2",
            "@type": "rdfs:Class"
          }
        ]
      };

      ontologizeServer.loadJsonFile = async () => testData;

      const result = await ontologizeServer.importFromFile(
        "test.json",
        mockOntologyCollection,
        {
          beforeSaveFn: (resource) => {
            // Only save Class1
            return resource._id === "ex:Class1" ? resource : false;
          }
        }
      );

      assert.isTrue(result.success);
      assert.equal(result.processedResources, 1);
      assert.equal(result.skippedResources, 1);

      const savedResource = ontologyData.find(r => r._id === "ex:Class1");
      assert.isObject(savedResource);

      const skippedResource = ontologyData.find(r => r._id === "ex:Class2");
      assert.isUndefined(skippedResource);
    });
  });

  describe("FOAF Ontology Import Test Suite", function () {
    let foafData = [];
    let mockFoafCollection;

    beforeEach(function () {
      // Reset foaf collection data
      foafData = [];

      // Create mock Foaf collection
      mockFoafCollection = {
        deleteMany: async () => {
          const deletedCount = foafData.length;
          foafData.length = 0;
          return { deletedCount };
        },
        replaceOne: async (filter, doc, opts) => {
          const index = foafData.findIndex(item => item._id === filter._id);
          if (index >= 0) {
            foafData[index] = doc;
          }
          else {
            foafData.push(doc);
          }
          return { acknowledged: true, matchedCount: index >= 0 ? 1 : 0, modifiedCount: 1, upsertedId: null };
        },
        find: (query) => ({
          toArray: async () => foafData.filter(item => {
            return Object.keys(query).every(key => item[key] === query[key]);
          })
        }),
        findOne: async (filter) => {
          return foafData.find(item => {
            return Object.keys(filter).every(key => item[key] === filter[key]);
          }) || null;
        }
      };
    });

    it("should import FOAF ontology with TBox resources going to Ontology collection", async function () {

      const filePath = "./tests/data/foaf.jsonld";

      // Test import of FOAF ontology
      const result = await ontologizeServer.importFromFile(
        filePath,
        mockFoafCollection
      );

      assert.isTrue(result.success);
      assert.isTrue(result.processedResources > 0);

      console.log("FOAF Import Results:");
      console.log(`- Total resources: ${result.totalResources}`);
      console.log(`- Processed resources: ${result.processedResources}`);
      console.log(`- TBox resources: ${result.tboxResources}`);
      console.log(`- ABox resources: ${result.aboxResources}`);

      // All FOAF resources should be TBox resources (Classes, Properties, Ontology)
      console.log("- ABox resources:",foafData);
      assert.equal(result.aboxResources, 0, "FOAF should contain only TBox resources");
      assert.isTrue(result.tboxResources > 0, "FOAF should contain TBox resources");

      // Verify TBox resources are in the Ontology collection, not the Foaf collection
      assert.equal(foafData.length, 0, "No resources should be in the Foaf collection since all are TBox");
      assert.isTrue(ontologyData.length > 0, "TBox resources should be in the Ontology collection");

      // Log what ended up in each collection
      console.log("\nCollection Distribution:");
      console.log(`- Ontology collection: ${ontologyData.length} resources`);
      console.log(`- Foaf collection: ${foafData.length} resources`);

      if (foafData.length > 0) {
        console.log("\nResources in Foaf collection:");
        foafData.forEach(resource => {
          console.log(`  - ${resource._id} (@type: ${JSON.stringify(resource["@type"])})`);
        });
      }

      // Verify specific FOAF classes are in the ontology collection
      // Note: Using expanded URIs because compaction may fail on FOAF data with null values
      // const foafPerson = ontologyData.find(r => r._id === "http://xmlns.com/foaf/0.1/Person");
      const foafPerson = ontologyData.find(r => r._id === "foaf:Person");
      assert.isObject(foafPerson, "foaf:Person should be in ontology collection");
      assert.isArray(foafPerson["@type"], "foaf:Person should have @type as array");
      assert.isTrue(
        foafPerson["@type"].includes("owl:Class") || foafPerson["@type"].includes("http://www.w3.org/2002/07/owl#Class"),
        "foaf:Person should be owl:Class"
      );

      // Verify specific FOAF properties are in the ontology collection
      const foafKnows = ontologyData.find(r => r._id === "foaf:knows");
      assert.isObject(foafKnows, "foaf:knows should be in ontology collection");
      assert.isArray(foafKnows["@type"], "foaf:knows should have @type as array");
      assert.isTrue(
        foafKnows["@type"].includes("owl:ObjectProperty") || foafKnows["@type"].includes("owl:ObjectProperty"),
        "foaf:knows should be owl:ObjectProperty"
      );

      // Verify the ontology definition itself
      const foafOntology = ontologyData.find(r => r._id === "http://xmlns.com/foaf/0.1/");
      assert.isObject(foafOntology, "FOAF ontology definition should be in ontology collection");
      assert.isArray(foafOntology["@type"], "FOAF ontology should have @type as array");
      assert.isTrue(
        foafOntology["@type"].includes("owl:Ontology") || foafOntology["@type"].includes("owl:Ontology"),
        "Should be owl:Ontology"
      );
    });

    it("should handle FOAF ontology with clearCollection option", async function () {
      // Pre-populate collections with test data
      ontologyData.push({ _id: "test:ExistingClass", "@type": ["rdfs:Class"] });
      foafData.push({ _id: "test:ExistingFoafResource", "@type": ["foaf:Person"] });

      const filePath = "./tests/data/foaf.jsonld";

      const result = await ontologizeServer.importFromFile(
        filePath,
        mockFoafCollection,
        { clearCollection: true }
      );

      assert.isTrue(result.success);

      // Foaf collection should be cleared but ontology collection should contain FOAF resources
      assert.equal(foafData.length, 0, "Foaf collection should be cleared and remain empty");
      assert.isTrue(ontologyData.length > 0, "Ontology collection should contain FOAF TBox resources");

      // Ontology is not cleared in this case, only the target FOAF collection
      assert.ok(ontologyData.some(r => r._id === "test:ExistingClass"), "Test data should be cleared from ontology");
      assert.isFalse(foafData.some(r => r._id === "test:ExistingFoafResource"), "Test data should be cleared from foaf");

      console.log("\nAfter clearCollection:");
      console.log(`- Ontology collection: ${ontologyData.length} FOAF resources`);
      console.log(`- Foaf collection: ${foafData.length} resources (should be 0)`);
    });

    it("should demonstrate TBox vs ABox resource classification", async function () {
      // Create mixed test data with both TBox and ABox resources
      const mixedData = [
        // TBox resources (ontology definitions)
        {
          "@id": "ex:TestClass",
          "@type": ["http://www.w3.org/2002/07/owl#Class"],
          "http://www.w3.org/2000/01/rdf-schema#label": [{ "@value": "Test Class" }]
        },
        {
          "@id": "ex:testProperty",
          "@type": ["http://www.w3.org/2002/07/owl#ObjectProperty"],
          "http://www.w3.org/2000/01/rdf-schema#label": [{ "@value": "Test Property" }]
        },
        // ABox resources (instances)
        {
          "@id": "ex:john",
          "@type": ["http://xmlns.com/foaf/0.1/Person"],
          "http://xmlns.com/foaf/0.1/name": [{ "@value": "John Doe" }]
        },
        {
          "@id": "ex:acmeOrg",
          "@type": ["http://xmlns.com/foaf/0.1/Organization"],
          "http://xmlns.com/foaf/0.1/name": [{ "@value": "ACME Organization" }]
        }
      ];

      const result = await ontologizeServer.importOntologyData(
        mixedData,
        mockFoafCollection
      );

      assert.isTrue(result.success);
      assert.equal(result.totalResources, 4);
      assert.equal(result.processedResources, 4);
      assert.equal(result.tboxResources, 2, "Should identify 2 TBox resources");
      assert.equal(result.aboxResources, 2, "Should identify 2 ABox resources");

      // TBox resources should be in ontology collection
      const tboxInOntology = ontologyData.filter(r =>
        r._id === "ex:TestClass" || r._id === "ex:testProperty"
      );
      assert.equal(tboxInOntology.length, 2, "TBox resources should be in ontology collection");

      // ABox resources should be in foaf collection
      const aboxInFoaf = foafData.filter(r =>
        r._id === "ex:john" || r._id === "ex:acmeOrg"
      );
      assert.equal(aboxInFoaf.length, 2, "ABox resources should be in foaf collection");

      console.log("\nMixed Import Results:");
      console.log(`- TBox resources in Ontology collection: ${tboxInOntology.map(r => r._id)}`);
      console.log(`- ABox resources in Foaf collection: ${aboxInFoaf.map(r => r._id)}`);
    });
  });
});
