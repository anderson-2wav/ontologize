import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { MeteorCollectionAdapter } from "../src/adapters/MeteorCollectionAdapter.js";

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

describe("Ontologize", function () {
  let ontologize;

  beforeEach(function () {
    // Mock collections for testing
    const mockOntologyCollection = {
      findOne: () => null,
      find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
      count: () => 0
    };
    const mockContextCollection = {
      findOne: () => null,
      find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
      count: () => 0
    };
    const mockStatementsCollection = createMockStatementsCollection();

    // Create adapters from mock collections
    const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
    const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
    const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");

    ontologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);
  });

  describe("constructor", function () {
    it("should create instance with default options", function () {
      assert.isObject(ontologize);
      assert.equal(ontologize.version, "0.1.0");
      assert.isObject(ontologize.opts);
      assert.isObject(ontologize.opts.defaultContext);
      assert.equal(ontologize.opts.debug, false);
    });

    it("should accept custom options", function () {
      const mockOntologyCollection = {
        findOne: () => null,
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };
      const mockContextCollection = {
        findOne: () => null,
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();
      const customOpts = {
        defaultContext: { "@vocab": "http://example.org/" },
        debug: true
      };
      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const customOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter, customOpts);
      assert.equal(customOntologize.opts.debug, true);
      assert.equal(customOntologize.opts.defaultContext["@vocab"], "http://example.org/");
    });

    it("should require statements collection as third parameter", function () {
      const mockOntologyCollection = {
        findOne: () => null,
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockContextCollection = {
        findOne: () => null,
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");

      const ontologizeWithStatements = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      assert.isObject(ontologizeWithStatements.collections.statements);
      assert.equal(ontologizeWithStatements.collections.statements, statementsAdapter);
    });

    it("should accept multiple collections through opts.collections", function () {
      const mockOntologyCollection = {
        findOne: () => null,
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockContextCollection = {
        findOne: () => null,
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();
      const mockNiceCollection = {
        findOne: () => null,
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const niceAdapter = new MeteorCollectionAdapter(mockNiceCollection, "nice");

      const opts = {
        collections: {
          Nice: niceAdapter
        }
      };

      const ontologizeWithCollections = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter, opts);

      assert.isObject(ontologizeWithCollections.collections.Nice);
      assert.equal(ontologizeWithCollections.collections.Nice, niceAdapter);
    });
  });

  describe("isValidOntologyResource", function () {
    it("should return true for valid ontology resource", function () {
      const validResource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };
      assert.isTrue(ontologize.isValidOntologyResource(validResource));
    });

    it("should return false for resource without @id", function () {
      const invalidResource = {
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };
      assert.isFalse(ontologize.isValidOntologyResource(invalidResource));
    });

    it("should return false for resource without @type", function () {
      const invalidResource = {
        "@id": "ex:TestClass",
        "rdfs:label": "Test Class"
      };
      assert.isFalse(ontologize.isValidOntologyResource(invalidResource));
    });
  });


  describe("getLabel", function () {
    it("should return rdfs:label when present", async function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };
      const label = await ontologize.getLabel(resource);
      assert.equal(label, "Test Class");
    });

    it("should return first label from array", async function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": ["Test Class", "Another Label"]
      };
      const label = await ontologize.getLabel(resource);
      assert.equal(label, "Test Class");
    });

    it("should extract label from @id when rdfs:label not present", async function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class"
      };
      const label = await ontologize.getLabel(resource);
      assert.equal(label, "TestClass");
    });

    it("should use fallback when no label or @id", async function () {
      const resource = {
        "@type": "owl:Class"
      };
      const label = await ontologize.getLabel(resource, "Fallback");
      assert.equal(label, "Fallback");
    });

    it("should use default fallback", async function () {
      const resource = {
        "@type": "owl:Class"
      };
      const label = await ontologize.getLabel(resource);
      assert.equal(label, "Unknown");
    });
  });

  describe("getLabelFromId", function () {
    it("should return label from resource lookup", async function () {
      // Mock collection with a test resource
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:TestClass") {
            return Promise.resolve({
              "_id": "ex:TestClass",
              "@type": ["owl:Class"],
              "rdfs:label": "Test Class"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const label = await testOntologize.getLabelFromId("ex:TestClass");
      assert.equal(label, "Test Class");
    });

    it("should extract label from ID when resource not found", async function () {
      const label = await ontologize.getLabelFromId("ex:UnknownClass");
      assert.equal(label, "UnknownClass");
    });

    it("should use fallback when extraction fails", async function () {
      const label = await ontologize.getLabelFromId("", "Custom Fallback");
      assert.equal(label, "Custom Fallback");
    });
  });

  describe("isArrayProperty", function () {
    it("should return false for special properties", async function () {
      assert.isFalse(await ontologize.isArrayProperty("__proto__"));
      assert.isFalse(await ontologize.isArrayProperty("123"));
    });

    it("should return true when current context has @container @list", async function () {
      const result = await ontologize.isArrayProperty("test:property", {
        context: {
          "test:property": {
            "@container": "@list"
          }
        }
      });
      assert.isTrue(result);
    });

    it("should return true when current context has @container @set", async function () {
      const result = await ontologize.isArrayProperty("test:property", {
        context: {
          "test:property": {
            "@container": "@set"
          }
        }
      });
      assert.isTrue(result);
    });

    it("should return false when current context has other @container values", async function () {
      const result = await ontologize.isArrayProperty("test:property", {
        context: {
          "test:property": {
            "@container": "@language"
          }
        }
      });
      assert.isFalse(result);
    });

    it("should return true when global context has @container @list", async function () {
      const mockContextCollection = {
        findOne: (query) => {
          if (query._id === "@id") {
            return Promise.resolve({
              "_id": "@id",
              "test:property": {
                "@container": "@list"
              }
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };

      const mockOntologyCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };

      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const result = await testOntologize.isArrayProperty("test:property");
      assert.isTrue(result);
    });

    it("should return true when ontology resource has bold:container @set", async function () {
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "test:property") {
            return Promise.resolve({
              "_id": "test:property",
              "@type": ["rdf:Property"],
              "bold:container": "@set"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const result = await testOntologize.isArrayProperty("test:property");
      assert.isTrue(result);
    });

    it("should return true when ontology resource has bold:container @list", async function () {
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "test:property") {
            return Promise.resolve({
              "_id": "test:property",
              "@type": ["rdf:Property"],
              "bold:container": "@list"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const result = await testOntologize.isArrayProperty("test:property");
      assert.isTrue(result);
    });

    it("should return false when no array indicators found", async function () {
      const result = await ontologize.isArrayProperty("unknown:property");
      assert.isFalse(result);
    });

    it("should prioritize current context over global context", async function () {
      const mockContextCollection = {
        findOne: (query) => {
          if (query._id === "@id") {
            return Promise.resolve({
              "_id": "@id",
              "test:property": {
                "@container": "@set"
              }
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };

      const mockOntologyCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
        fetch: () => [],
        toArray: () => Promise.resolve([])
      }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      // Current context says false, global context says true - should return false
      const result = await testOntologize.isArrayProperty("test:property", {
        context: {
          "test:property": {
            "@container": "@language"
          }
        }
      });
      assert.isFalse(result);
    });
  });

  describe("sortTypesFn", function () {
    it("should sort types by specificity with named classes before blank nodes", async function () {
      // Test data from bfo:has-member-part rdfs:domain
      const inputTypes = [
        "bfo:material-entity",
        "bfo:independent-continuant",
        "_:b29",
        "_:b30",
        "_:168",
        "_:170",
        "owl:Thing",
        "bfo:continuant",
        "_:b108",
        "_:128",
        "bfo:entity",
        "_:b3",
        "_:37",
        "_:b107",
        "_:124"
      ];

      // Create mock ontology collection with BFO class hierarchy
      const allClasses = [
        {
          "_id": "bfo:material-entity",
          "rdfs:subClassOf": ["bfo:independent-continuant"]
        },
        {
          "_id": "bfo:independent-continuant",
          "rdfs:subClassOf": ["bfo:continuant"]
        },
        {
          "_id": "bfo:continuant",
          "rdfs:subClassOf": ["bfo:entity"]
        },
        {
          "_id": "bfo:entity",
          "rdfs:subClassOf": ["owl:Thing"]
        },
        {
          "_id": "owl:Thing"
          // No subClassOf - top level
        }
      ];

      const mockOntologyCollection = {
        find: (query) => ({
          toArray: () => {
            // Filter based on query._id.$in if present
            if (query && query._id && query._id.$in) {
              const ids = query._id.$in;
              return Promise.resolve(allClasses.filter(c => ids.includes(c._id)));
            }
            return Promise.resolve(allClasses);
          }
        })
      };

      // Create mock context collection
      const mockContextCollection = {
        findOne: () => Promise.resolve(null)
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const testOntologize = new Ontologize(mockOntologyCollection, mockContextCollection, mockStatementsCollection);
      const sortedTypes = await testOntologize.sortTypesFn(inputTypes);

      assert.isArray(sortedTypes);
      assert.equal(sortedTypes.length, inputTypes.length);

      // Check that named classes come before blank nodes
      const namedClassesEnd = sortedTypes.findIndex(type => type.startsWith("_:"));
      if (namedClassesEnd !== -1) {
        // There are blank nodes, so check all named classes come before them
        for (let i = 0; i < namedClassesEnd; i++) {
          assert.isFalse(sortedTypes[i].startsWith("_:"), `Named class should come before blank nodes: ${sortedTypes[i]}`);
        }
        for (let i = namedClassesEnd; i < sortedTypes.length; i++) {
          assert.isTrue(sortedTypes[i].startsWith("_:"), `Blank node should come after named classes: ${sortedTypes[i]}`);
        }
      }

      // Check BFO specificity order (most specific to least specific)
      const namedClasses = sortedTypes.filter(type => !type.startsWith("_:"));
      const materialEntityIndex = namedClasses.indexOf("bfo:material-entity");
      const independentContinuantIndex = namedClasses.indexOf("bfo:independent-continuant");
      const continuantIndex = namedClasses.indexOf("bfo:continuant");
      const entityIndex = namedClasses.indexOf("bfo:entity");
      const thingIndex = namedClasses.indexOf("owl:Thing");

      // More specific classes should come before less specific classes
      if (materialEntityIndex !== -1 && independentContinuantIndex !== -1) {
        assert.isBelow(materialEntityIndex, independentContinuantIndex,
          "bfo:material-entity should come before bfo:independent-continuant");
      }
      if (independentContinuantIndex !== -1 && continuantIndex !== -1) {
        assert.isBelow(independentContinuantIndex, continuantIndex,
          "bfo:independent-continuant should come before bfo:continuant");
      }
      if (continuantIndex !== -1 && entityIndex !== -1) {
        assert.isBelow(continuantIndex, entityIndex,
          "bfo:continuant should come before bfo:entity");
      }
      if (entityIndex !== -1 && thingIndex !== -1) {
        assert.isBelow(entityIndex, thingIndex,
          "bfo:entity should come before owl:Thing");
      }

      console.log("Input types:", inputTypes);
      console.log("Sorted types:", sortedTypes);
    });

    it("should handle bfo:bearer-of rdfs:range case correctly", async function () {
      // Test case from BFO reasoning where owl:Thing was appearing before bfo:entity
      const inputTypes = [
        "bfo:specifically-dependent-continuant",
        "bfo:continuant",
        "owl:Thing",
        "bfo:entity",
        "_:b3",
        "_:b37",
        "_:b107",
        "_:b124"
      ];

      // Create mock with full hierarchy including owl:Thing as parent of bfo:entity
      const allClasses = [
        {
          "_id": "bfo:specifically-dependent-continuant",
          "rdfs:subClassOf": ["bfo:continuant"]
        },
        {
          "_id": "bfo:continuant",
          "rdfs:subClassOf": ["bfo:entity"]
        },
        {
          "_id": "bfo:entity",
          "rdfs:subClassOf": ["owl:Thing"]
        },
        {
          "_id": "owl:Thing"
          // No subClassOf - top level
        }
      ];

      const mockOntologyCollection = {
        find: (query) => ({
          toArray: () => {
            // Filter based on query._id.$in if present
            if (query && query._id && query._id.$in) {
              const ids = query._id.$in;
              return Promise.resolve(allClasses.filter(c => ids.includes(c._id)));
            }
            return Promise.resolve(allClasses);
          }
        })
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null)
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const testOntologize = new Ontologize(mockOntologyCollection, mockContextCollection, mockStatementsCollection);
      const sortedTypes = await testOntologize.sortTypesFn(inputTypes);

      console.log("bfo:bearer-of input:", inputTypes);
      console.log("bfo:bearer-of sorted:", sortedTypes);

      const namedClasses = sortedTypes.filter(type => !type.startsWith("_:"));
      const entityIndex = namedClasses.indexOf("bfo:entity");
      const thingIndex = namedClasses.indexOf("owl:Thing");

      // bfo:entity should come before owl:Thing
      assert.isBelow(entityIndex, thingIndex, "bfo:entity should come before owl:Thing");
    });

    it("should handle empty array", async function () {
      const sorted = await ontologize.sortTypesFn([]);
      assert.isArray(sorted);
      assert.equal(sorted.length, 0);
    });

    it("should handle single type", async function () {
      const sorted = await ontologize.sortTypesFn(["bfo:entity"]);
      assert.isArray(sorted);
      assert.equal(sorted.length, 1);
      assert.equal(sorted[0], "bfo:entity");
    });

    it("should separate named classes from blank nodes", async function () {
      const types = ["bfo:entity", "_:blank1", "owl:Thing", "_:blank2"];
      const sorted = await ontologize.sortTypesFn(types);

      assert.isArray(sorted);
      assert.equal(sorted.length, 4);

      // Find where blank nodes start
      const firstBlankIndex = sorted.findIndex(type => type.startsWith("_:"));

      // All named classes should come before blank nodes
      for (let i = 0; i < firstBlankIndex; i++) {
        assert.isFalse(sorted[i].startsWith("_:"));
      }

      // All items after first blank should be blank nodes
      for (let i = firstBlankIndex; i < sorted.length; i++) {
        assert.isTrue(sorted[i].startsWith("_:"));
      }
    });
  });

  describe("getVersion", function () {
    it("should return version string", function () {
      const version = ontologize.getVersion();
      assert.isString(version);
      assert.equal(version, "0.1.0");
    });
  });

  describe("getLocation", function () {
    it("should return null for resource with no location information", async function () {
      const resource = {
        "@id": "ex:NoLocationResource",
        "@type": "ex:Thing",
        "rdfs:label": "No Location"
      };
      const location = await ontologize.getLocation(resource);
      assert.isNull(location);
    });

    it("should return GeoPoint for resource with geo:lat and geo:long properties", async function () {
      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "geo:lat": 34.0598954,
        "geo:long": -118.4464607
      };
      const location = await ontologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      assert.isArray(location.coordinates);
      assert.equal(location.coordinates[0], -118.4464607);  // lng first in GeoJSON
      assert.equal(location.coordinates[1], 34.0598954);    // lat second
    });

    it("should handle geo:lat and geo:long as JSON-LD @value objects", async function () {
      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "geo:lat": { "@value": "34.0598954", "@type": "xsd:decimal" },
        "geo:long": { "@value": "-118.4464607", "@type": "xsd:decimal" }
      };
      const location = await ontologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      assert.closeTo(location.coordinates[0], -118.4464607, 0.0001);
      assert.closeTo(location.coordinates[1], 34.0598954, 0.0001);
    });

    it("should handle geo:lat and geo:long as string values", async function () {
      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "geo:lat": "34.0598954",
        "geo:long": "-118.4464607"
      };
      const location = await ontologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      assert.closeTo(location.coordinates[0], -118.4464607, 0.0001);
      assert.closeTo(location.coordinates[1], 34.0598954, 0.0001);
    });

    it("should return GeoPoint for property with rdfs:range bold:GeoPoint", async function () {
      // Create mock with property definition
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:hasLocation") {
            return Promise.resolve({
              "_id": "ex:hasLocation",
              "@type": ["owl:DatatypeProperty"],
              "rdfs:range": "bold:GeoPoint"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "ex:hasLocation": {
          type: "Point",
          coordinates: [-118.4464607, 34.0598954]
        }
      };

      const location = await testOntologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      assert.deepEqual(location.coordinates, [-118.4464607, 34.0598954]);
    });

    it("should return GeoJSON for property with rdfs:range bold:GeoJSON", async function () {
      // Create mock with property definition
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:hasGeometry") {
            return Promise.resolve({
              "_id": "ex:hasGeometry",
              "@type": ["owl:DatatypeProperty"],
              "rdfs:range": "bold:GeoJSON"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const resource = {
        "@id": "ex:PolygonResource",
        "@type": "ex:Area",
        "ex:hasGeometry": {
          type: "Polygon",
          coordinates: [[[-118.5, 34.0], [-118.4, 34.0], [-118.4, 34.1], [-118.5, 34.1], [-118.5, 34.0]]]
        }
      };

      const location = await testOntologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Polygon");
      assert.isArray(location.coordinates);
    });

    it("should handle GeoJSON stored as JSON string", async function () {
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:hasLocation") {
            return Promise.resolve({
              "_id": "ex:hasLocation",
              "@type": ["owl:DatatypeProperty"],
              "rdfs:range": "bold:GeoPoint"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "ex:hasLocation": JSON.stringify({
          type: "Point",
          coordinates: [-118.4464607, 34.0598954]
        })
      };

      const location = await testOntologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      assert.deepEqual(location.coordinates, [-118.4464607, 34.0598954]);
    });

    it("should handle GeoJSON wrapped in JSON-LD @value", async function () {
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:hasLocation") {
            return Promise.resolve({
              "_id": "ex:hasLocation",
              "@type": ["owl:DatatypeProperty"],
              "rdfs:range": "bold:GeoPoint"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "ex:hasLocation": {
          "@value": JSON.stringify({
            type: "Point",
            coordinates: [-118.4464607, 34.0598954]
          }),
          "@type": "bold:GeoPoint"
        }
      };

      const location = await testOntologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      assert.deepEqual(location.coordinates, [-118.4464607, 34.0598954]);
    });

    it("should prefer geo:lat/geo:long over properties with rdfs:range", async function () {
      // Even though ex:hasLocation has rdfs:range bold:GeoPoint, geo:lat/geo:long should take precedence
      const mockOntologyCollection = {
        findOne: (query) => {
          if (query._id === "ex:hasLocation") {
            return Promise.resolve({
              "_id": "ex:hasLocation",
              "@type": ["owl:DatatypeProperty"],
              "rdfs:range": "bold:GeoPoint"
            });
          }
          return Promise.resolve(null);
        },
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({
          fetch: () => [],
          toArray: () => Promise.resolve([])
        }),
        count: () => 0
      };
      const mockStatementsCollection = createMockStatementsCollection();

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "context");
      const statementsAdapter = new MeteorCollectionAdapter(mockStatementsCollection, "statements");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter, statementsAdapter);

      const resource = {
        "@id": "ex:LocatedResource",
        "@type": "ex:Place",
        "geo:lat": 40.7128,
        "geo:long": -74.0060,
        "ex:hasLocation": {
          type: "Point",
          coordinates: [-118.4464607, 34.0598954]
        }
      };

      const location = await testOntologize.getLocation(resource);
      assert.isObject(location);
      assert.equal(location.type, "Point");
      // Should use geo:lat/geo:long values, not ex:hasLocation
      assert.closeTo(location.coordinates[0], -74.0060, 0.0001);
      assert.closeTo(location.coordinates[1], 40.7128, 0.0001);
    });

    it("should return null when geo:lat is present but geo:long is missing", async function () {
      const resource = {
        "@id": "ex:PartialLocationResource",
        "@type": "ex:Place",
        "geo:lat": 34.0598954
        // geo:long is missing
      };
      const location = await ontologize.getLocation(resource);
      assert.isNull(location);
    });

    it("should return null when geo:long is present but geo:lat is missing", async function () {
      const resource = {
        "@id": "ex:PartialLocationResource",
        "@type": "ex:Place",
        "geo:long": -118.4464607
        // geo:lat is missing
      };
      const location = await ontologize.getLocation(resource);
      assert.isNull(location);
    });
  });

  describe("isStatementResource", function () {
    it("should return true for resource with @type rdf:Statement", function () {
      const resource = {
        "@id": "ex:statement-1",
        "@type": "rdf:Statement",
        "rdf:subject": "ex:Subject",
        "rdf:predicate": "ex:predicate",
        "rdf:object": "ex:Object"
      };
      assert.isTrue(ontologize.isStatementResource(resource));
    });

    it("should return true for resource with @type rdf:Statement in array", function () {
      const resource = {
        "@id": "ex:statement-1",
        "@type": ["rdf:Statement", "ex:OtherType"],
        "rdf:subject": "ex:Subject",
        "rdf:predicate": "ex:predicate",
        "rdf:object": "ex:Object"
      };
      assert.isTrue(ontologize.isStatementResource(resource));
    });

    it("should return true for resource with expanded rdf:Statement URI", function () {
      const resource = {
        "@id": "ex:statement-1",
        "@type": "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement",
        "rdf:subject": "ex:Subject",
        "rdf:predicate": "ex:predicate",
        "rdf:object": "ex:Object"
      };
      assert.isTrue(ontologize.isStatementResource(resource));
    });

    it("should return true for resource with rdf:subject, rdf:predicate, rdf:object properties (no @type)", function () {
      // This is the key case - detection by properties alone
      const resource = {
        "@id": "dwcbfo:dwc-bfo-statement-1",
        "rdf:subject": "dwc:Dataset",
        "rdf:predicate": "rdfs:subClassOf",
        "rdf:object": "bfo:immaterial-entity",
        "dcterms:isPartOf": "dwcbfo:dwcbfo.owl"
      };
      assert.isTrue(ontologize.isStatementResource(resource));
    });

    it("should return true for resource with expanded RDF property URIs", function () {
      const resource = {
        "@id": "ex:statement-1",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject": "ex:Subject",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate": "ex:predicate",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#object": "ex:Object"
      };
      assert.isTrue(ontologize.isStatementResource(resource));
    });

    it("should return false for resource without Statement type or properties", function () {
      const resource = {
        "@id": "ex:RegularResource",
        "@type": "owl:Class",
        "rdfs:label": "Regular Class"
      };
      assert.isFalse(ontologize.isStatementResource(resource));
    });

    it("should return false for resource with only rdf:subject (missing other properties)", function () {
      const resource = {
        "@id": "ex:Incomplete",
        "rdf:subject": "ex:Subject"
      };
      assert.isFalse(ontologize.isStatementResource(resource));
    });

    it("should return false for resource with only rdf:subject and rdf:predicate (missing rdf:object)", function () {
      const resource = {
        "@id": "ex:Incomplete",
        "rdf:subject": "ex:Subject",
        "rdf:predicate": "ex:predicate"
      };
      assert.isFalse(ontologize.isStatementResource(resource));
    });

    it("should return true for resource with all three properties and additional metadata", function () {
      // Real-world example with dcterms metadata
      const resource = {
        "@id": "dwcbfo:dwc-bfo-statement-1",
        "rdf:subject": "dwc:Dataset",
        "rdf:predicate": "rdfs:subClassOf",
        "rdf:object": "bfo:immaterial-entity",
        "dcterms:isPartOf": "dwcbfo:dwcbfo.owl",
        "rdfs:comment": "This statement bridges DWC and BFO ontologies"
      };
      assert.isTrue(ontologize.isStatementResource(resource));
    });
  });
});
