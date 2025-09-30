import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { MeteorCollectionAdapter } from "../src/adapters/MeteorCollectionAdapter.js";

describe("Ontologize", function () {
  let ontologize;

  beforeEach(function () {
    // Mock collections for testing
    const mockOntologyCollection = {
      findOne: () => null,
      find: () => ({ fetch: () => [] }),
      count: () => 0
    };
    const mockContextCollection = {
      findOne: () => null,
      find: () => ({ fetch: () => [] }),
      count: () => 0
    };

    // Create adapters from mock collections
    const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
    const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
    
    ontologize = new Ontologize(ontologyAdapter, contextAdapter);
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
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };
      const mockContextCollection = {
        findOne: () => null,
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };
      const customOpts = {
        defaultContext: { "@vocab": "http://example.org/" },
        debug: true
      };
      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
      const customOntologize = new Ontologize(ontologyAdapter, contextAdapter, customOpts);
      assert.equal(customOntologize.opts.debug, true);
      assert.equal(customOntologize.opts.defaultContext["@vocab"], "http://example.org/");
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
    it("should return rdfs:label when present", function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };
      const label = ontologize.getLabel(resource);
      assert.equal(label, "Test Class");
    });

    it("should return first label from array", function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": ["Test Class", "Another Label"]
      };
      const label = ontologize.getLabel(resource);
      assert.equal(label, "Test Class");
    });

    it("should extract label from @id when rdfs:label not present", function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class"
      };
      const label = ontologize.getLabel(resource);
      assert.equal(label, "TestClass");
    });

    it("should use fallback when no label or @id", function () {
      const resource = {
        "@type": "owl:Class"
      };
      const label = ontologize.getLabel(resource, "Fallback");
      assert.equal(label, "Fallback");
    });

    it("should use default fallback", function () {
      const resource = {
        "@type": "owl:Class"
      };
      const label = ontologize.getLabel(resource);
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
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };
      
      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter);

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
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const mockOntologyCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter);

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
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter);

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
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const mockContextCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter);

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
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const mockOntologyCollection = {
        findOne: () => Promise.resolve(null),
        find: () => ({ fetch: () => [] }),
        count: () => 0
      };

      const ontologyAdapter = new MeteorCollectionAdapter(mockOntologyCollection, "Ontology");
      const contextAdapter = new MeteorCollectionAdapter(mockContextCollection, "Context");
      const testOntologize = new Ontologize(ontologyAdapter, contextAdapter);

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
      const mockOntologyCollection = {
        find: (query) => ({
          toArray: () => Promise.resolve([
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
          ])
        })
      };

      // Create mock context collection
      const mockContextCollection = {
        findOne: () => Promise.resolve(null)
      };

      const testOntologize = new Ontologize(mockOntologyCollection, mockContextCollection);
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
});
