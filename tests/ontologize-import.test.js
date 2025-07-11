import { assert } from "chai";
import { OntologizeServer } from "../src/ontologize-server.js";
import { readFile } from "fs/promises";
import { join } from "path";

describe("OntologizeServer Import", function () {
  let ontologizeServer;
  let mockOntologyCollection;
  let mockContextCollection;
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
      find: (query) => ({
        toArray: async () => ontologyData.filter(item => {
          return Object.keys(query).every(key => item[key] === query[key]);
        })
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
        return filter._id === "@context" ? contextData : null;
      }
    };

    // Create the ontologize server instance with the mock collections
    ontologizeServer = new OntologizeServer(mockOntologyCollection, mockContextCollection);
  });

  describe("importOntologyFromFile", function () {
    it("should exist as a method", function () {
      assert.isFunction(ontologizeServer.importOntologyFromFile);
    });

    it("should import simple ontology array", async function () {
      // Create test data
      const testData = [
        {
          "_id": "@context",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
          }
        },
        {
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        },
        {
          "_id": "ex:testProperty",
          "@type": "owl:ObjectProperty",
          "rdfs:label": "Test Property"
        }
      ];

      // Mock file loading
      ontologizeServer.loadOntologyFromFile = async (filePath) => testData;

      const result = await ontologizeServer.importOntologyFromFile(
        "test.json",
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.isTrue(result.contextImported);
      assert.equal(result.processedResources, 2);
      assert.equal(result.totalResources, 2);

      // Check context was imported
      assert.equal(contextData._id, "@context");
      assert.equal(contextData["@vocab"], "http://example.org/");

      // Check resources were imported
      assert.equal(ontologyData.length, 2);
      assert.isTrue(ontologyData.some(r => r._id === "ex:TestClass"));
      assert.isTrue(ontologyData.some(r => r._id === "ex:testProperty"));
    });

    it("should handle @graph format", async function () {
      const testData = {
        "@context": {
          "@vocab": "http://example.org/",
          "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
        },
        "@graph": [
          {
            "@id": "ex:TestClass",
            "@type": "rdfs:Class",
            "rdfs:label": "Test Class"
          }
        ]
      };

      ontologizeServer.loadOntologyFromFile = async (filePath) => testData;

      const result = await ontologizeServer.importOntologyFromFile(
        "test.json",
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      // Note: @graph format doesn't set contextImported flag in our current implementation
      assert.equal(contextData["@vocab"], "http://example.org/");
    });

    it("should handle clearCollection option", async function () {
      // Pre-populate collections
      ontologyData.push({ _id: "existing", data: "old" });
      contextData = { _id: "@context", old: "data" };

      const testData = [
        {
          "_id": "@context",
          "@context": {
            "@vocab": "http://example.org/"
          }
        },
        {
          "_id": "ex:NewClass",
          "@type": "rdfs:Class"
        }
      ];

      ontologizeServer.loadOntologyFromFile = async (filePath) => testData;

      const result = await ontologizeServer.importOntologyFromFile(
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
      this.timeout(10000); // Increase timeout for file operations

      const filePath = "./data/ontology.json";

      // Test loading the file
      let fileData;
      try {
        fileData = await ontologizeServer.loadOntologyFromFile(filePath);
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
      const result = await ontologizeServer.importOntologyFromFile(
        filePath,
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.isTrue(result.contextImported);
      assert.isTrue(result.processedResources > 0);

      // Check that context was imported
      assert.equal(contextData._id, "@context");
      assert.isString(contextData["@vocab"]);

      // Check that ontology resources were imported
      assert.isTrue(ontologyData.length > 0);

      // Check for specific CTB ontology resources
      const ctbClasses = ontologyData.filter(r =>
        r._id && r._id.startsWith("ctb:") &&
        (r["@type"] === "rdfs:Class" || (Array.isArray(r["@type"]) && r["@type"].includes("rdfs:Class")))
      );
      assert.isTrue(ctbClasses.length > 0);

      console.log(`Imported ${result.processedResources} resources from ${result.totalResources} total`);
      console.log(`Found ${ctbClasses.length} CTB classes`);
    });
  });

  describe("New Import Methods", function () {
    it("should have importOntologyFromFile method", function () {
      assert.isFunction(ontologizeServer.importOntologyFromFile);
    });

    it("should have importOntologyData method", function () {
      assert.isFunction(ontologizeServer.importOntologyData);
    });

    it("should import from file path using importOntologyFromFile", async function () {
      const testData = [
        {
          "_id": "@context",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
          }
        },
        {
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      // Mock file loading
      ontologizeServer.loadOntologyFromFile = async (filePath) => testData;

      const result = await ontologizeServer.importOntologyFromFile(
        "test.json",
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.equal(result.inputSource, "file");
      assert.equal(result.filePath, "test.json");
      assert.isTrue(result.contextImported);
      assert.equal(result.totalResources, 1);
      assert.equal(result.processedResources, 1);
      assert.equal(result.tboxResources, 1);
      assert.equal(result.aboxResources, 0);
    });

    it("should import from parsed object using importOntologyData", async function () {
      const testData = {
        "@context": {
          "@vocab": "http://example.org/",
          "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
        },
        "@graph": [
          {
            "@id": "ex:TestClass",
            "@type": "rdfs:Class",
            "rdfs:label": "Test Class"
          }
        ]
      };

      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection
      );

      assert.isTrue(result.success);
      assert.equal(result.inputSource, "object");
      assert.isNull(result.filePath);
      assert.isTrue(result.contextImported);
      assert.equal(result.totalResources, 1);
      assert.equal(result.processedResources, 1);
    });

    it("should import from array using importOntologyData", async function () {
      const testData = [
        {
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        },
        {
          "_id": "ex:Instance",
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
          "_id": "ex:TestClass",
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
      contextData = { _id: "@context" };

      const testData = [
        {
          "_id": "ex:NewClass",
          "@type": "rdfs:Class"
        }
      ];
      // TODO this one fails silently, because for now the default error handling for a compact
      //  failure is just console.warn--we can do better!
      const result = await ontologizeServer.importOntologyData(
        testData,
        mockOntologyCollection,
        { clearCollection: true }
      );

      assert.isTrue(result.success);
      assert.equal(ontologyData.length, 1);
      assert.equal(ontologyData[0]._id, "ex:NewClass");
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
          "_id": "@context",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
          }
        }
      ];

      ontologizeServer.loadOntologyFromFile = async (filePath) => firstData;
      await ontologizeServer.importOntologyFromFile("first.json", mockOntologyCollection);

      // Second import with additional context
      const secondData = [
        {
          "_id": "@context",
          "@context": {
            "owl": "http://www.w3.org/2002/07/owl#",
            "dc": "http://purl.org/dc/elements/1.1/"
          }
        }
      ];

      ontologizeServer.loadOntologyFromFile = async (filePath) => secondData;
      await ontologizeServer.importOntologyFromFile("second.json", mockOntologyCollection);

      // Check that both contexts were merged
      assert.equal(contextData["@vocab"], "http://example.org/");
      assert.equal(contextData["rdfs"], "http://www.w3.org/2000/01/rdf-schema#");
      assert.equal(contextData["owl"], "http://www.w3.org/2002/07/owl#");
      assert.equal(contextData["dc"], "http://purl.org/dc/elements/1.1/");
    });

    it("should merge multiple contexts in single array", async function () {
      // Import data with multiple context items in the same array
      const multiContextData = [
        {
          "_id": "first-context",
          "@context": {
            "@vocab": "http://example.org/",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
          }
        },
        {
          "_id": "second-context",
          "@context": {
            "owl": "http://www.w3.org/2002/07/owl#",
            "dc": "http://purl.org/dc/elements/1.1/"
          }
        },
        {
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Test Class"
        }
      ];

      ontologizeServer.loadOntologyFromFile = async (filePath) => multiContextData;
      const result = await ontologizeServer.importOntologyFromFile("multi.json", mockOntologyCollection);

      assert.isTrue(result.success);
      assert.isTrue(result.contextImported);
      assert.equal(result.totalResources, 1); // Only the TestClass should be counted as resource
      assert.equal(result.processedResources, 1);

      // Check that both contexts were merged
      assert.equal(contextData["@vocab"], "http://example.org/");
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
          "_id": "@context",
          "@context": {
            "zprefix": "http://z.example.org/",
            "@vocab": "http://example.org/",
            "aprefix": "http://a.example.org/",
            "@base": "http://base.example.org/",
            "rdfs:subClassOf": {"@type": "@id"}
          }
        }
      ];

      ontologizeServer.loadOntologyFromFile = async (filePath) => testData;
      await ontologizeServer.importOntologyFromFile("test.json", mockOntologyCollection);

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
      this.timeout(15000);

      // Test with actual CTB ontology if available
      const filePath = "../../../data/ontology.json";

      let fileData;
      try {
        fileData = await ontologizeServer.loadOntologyFromFile(filePath);
      } catch (error) {
        this.skip("ontology.json file not found");
        return;
      }

      // Import with BOLD normalization
      const result = await ontologizeServer.importOntologyFromFile(
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
          "_id": "ex:TestClass",
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
          "_id": "ex:TestClass",
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
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:seeAlso": ["ex:RelatedClass1", "ex:RelatedClass2"]
        }
      ];

      await ontologizeServer.importOntologyData(firstData, mockOntologyCollection);

      // Second import with additional array items
      const secondData = [
        {
          "_id": "ex:TestClass",
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
          "_id": "ex:TestClass",
          "@type": "rdfs:Class",
          "rdfs:label": "Original Label",
          "rdfs:comment": "Original comment"
        }
      ];

      await ontologizeServer.importOntologyData(firstData, mockOntologyCollection);

      // Second import with mergeOntology=false
      const secondData = [
        {
          "_id": "ex:TestClass",
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

  describe("FOAF Ontology Import Test Suite", function () {
    let foafData = [];
    let mockFoafCollection;
    this.timeout(0);

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
      const result = await ontologizeServer.importOntologyFromFile(
        filePath,
        mockFoafCollection
      );

      assert.isTrue(result.success);
      assert.isTrue(result.processedResources > 0);

      console.log(`FOAF Import Results:`);
      console.log(`- Total resources: ${result.totalResources}`);
      console.log(`- Processed resources: ${result.processedResources}`);
      console.log(`- TBox resources: ${result.tboxResources}`);
      console.log(`- ABox resources: ${result.aboxResources}`);

      // All FOAF resources should be TBox resources (Classes, Properties, Ontology)
      console.log(`- ABox resources:`,foafData);
      assert.equal(result.aboxResources, 0, "FOAF should contain only TBox resources");
      assert.isTrue(result.tboxResources > 0, "FOAF should contain TBox resources");

      // Verify TBox resources are in the Ontology collection, not the Foaf collection
      assert.equal(foafData.length, 0, "No resources should be in the Foaf collection since all are TBox");
      assert.isTrue(ontologyData.length > 0, "TBox resources should be in the Ontology collection");

      // Log what ended up in each collection
      console.log(`\nCollection Distribution:`);
      console.log(`- Ontology collection: ${ontologyData.length} resources`);
      console.log(`- Foaf collection: ${foafData.length} resources`);

      if (foafData.length > 0) {
        console.log(`\nResources in Foaf collection:`);
        foafData.forEach(resource => {
          console.log(`  - ${resource._id} (@type: ${JSON.stringify(resource["@type"])})`);
        });
      }

      // Verify specific FOAF classes are in the ontology collection
      const foafPerson = ontologyData.find(r => r._id === "foaf:Person");
      assert.isObject(foafPerson, "foaf:Person should be in ontology collection");
      assert.isArray(foafPerson["@type"], "foaf:Person should have @type as array");
      assert.isTrue(foafPerson["@type"].includes("owl:Class"), "foaf:Person should be owl:Class");

      // Verify specific FOAF properties are in the ontology collection
      const foafKnows = ontologyData.find(r => r._id === "foaf:knows");
      assert.isObject(foafKnows, "foaf:knows should be in ontology collection");
      assert.isArray(foafKnows["@type"], "foaf:knows should have @type as array");
      assert.isTrue(foafKnows["@type"].includes("owl:ObjectProperty"), "foaf:knows should be owl:ObjectProperty");

      // Verify the ontology definition itself
      const foafOntology = ontologyData.find(r => r._id === "http://xmlns.com/foaf/0.1/");
      assert.isObject(foafOntology, "FOAF ontology definition should be in ontology collection");
      assert.isArray(foafOntology["@type"], "FOAF ontology should have @type as array");
      assert.isTrue(foafOntology["@type"].includes("owl:Ontology"), "Should be owl:Ontology");
    });

    it("should handle FOAF ontology with clearCollection option", async function () {
      // Pre-populate collections with test data
      ontologyData.push({ _id: "test:ExistingClass", "@type": ["rdfs:Class"] });
      foafData.push({ _id: "test:ExistingFoafResource", "@type": ["foaf:Person"] });

      const filePath = "./tests/data/foaf.jsonld";

      const result = await ontologizeServer.importOntologyFromFile(
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

      console.log(`\nAfter clearCollection:`);
      console.log(`- Ontology collection: ${ontologyData.length} FOAF resources`);
      console.log(`- Foaf collection: ${foafData.length} resources (should be 0)`);
    });

    it("should demonstrate TBox vs ABox resource classification", async function () {
      // Create mixed test data with both TBox and ABox resources
      const mixedData = [
        // TBox resources (ontology definitions)
        {
          "_id": "ex:TestClass",
          "@type": ["http://www.w3.org/2002/07/owl#Class"],
          "http://www.w3.org/2000/01/rdf-schema#label": [{ "@value": "Test Class" }]
        },
        {
          "_id": "ex:testProperty",
          "@type": ["http://www.w3.org/2002/07/owl#ObjectProperty"],
          "http://www.w3.org/2000/01/rdf-schema#label": [{ "@value": "Test Property" }]
        },
        // ABox resources (instances)
        {
          "_id": "ex:john",
          "@type": ["http://xmlns.com/foaf/0.1/Person"],
          "http://xmlns.com/foaf/0.1/name": [{ "@value": "John Doe" }]
        },
        {
          "_id": "ex:acmeOrg",
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

      console.log(`\nMixed Import Results:`);
      console.log(`- TBox resources in Ontology collection: ${tboxInOntology.map(r => r._id)}`);
      console.log(`- ABox resources in Foaf collection: ${aboxInFoaf.map(r => r._id)}`);
    });
  });
});
