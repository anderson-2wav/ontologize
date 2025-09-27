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

  describe("getVersion", function () {
    it("should return version string", function () {
      const version = ontologize.getVersion();
      assert.isString(version);
      assert.equal(version, "0.1.0");
    });
  });
});
