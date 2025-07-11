import { assert } from "chai";
import { Ontologize } from "../src/ontologize.js";

describe("Ontologize", function () {
  let ontologize;

  beforeEach(function () {
    // Mock collections for testing
    const mockOntologyCollection = {};
    const mockContextCollection = {};
    ontologize = new Ontologize(mockOntologyCollection, mockContextCollection);
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
      const mockOntologyCollection = {};
      const mockContextCollection = {};
      const customOpts = {
        defaultContext: { "@vocab": "http://example.org/" },
        debug: true
      };
      const customOntologize = new Ontologize(mockOntologyCollection, mockContextCollection, customOpts);
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

  describe("extractClasses", function () {
    it("should extract single class resource", function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };
      const classes = ontologize.extractClasses(resource);
      assert.isArray(classes);
      assert.equal(classes.length, 1);
      assert.equal(classes[0]["@id"], "ex:TestClass");
    });

    it("should extract class with multiple types", function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": ["owl:Class", "rdfs:Class"],
        "rdfs:label": "Test Class"
      };
      const classes = ontologize.extractClasses(resource);
      assert.isArray(classes);
      assert.equal(classes.length, 1);
      assert.equal(classes[0]["@id"], "ex:TestClass");
    });

    it("should return empty array for non-class resource", function () {
      const resource = {
        "@id": "ex:TestProperty",
        "@type": "owl:ObjectProperty",
        "rdfs:label": "Test Property"
      };
      const classes = ontologize.extractClasses(resource);
      assert.isArray(classes);
      assert.equal(classes.length, 0);
    });
  });

  describe("extractProperties", function () {
    it("should extract object property", function () {
      const resource = {
        "@id": "ex:testProperty",
        "@type": "owl:ObjectProperty",
        "rdfs:label": "Test Property"
      };
      const properties = ontologize.extractProperties(resource);
      assert.isArray(properties);
      assert.equal(properties.length, 1);
      assert.equal(properties[0]["@id"], "ex:testProperty");
    });

    it("should extract datatype property", function () {
      const resource = {
        "@id": "ex:testProperty",
        "@type": "owl:DatatypeProperty",
        "rdfs:label": "Test Property"
      };
      const properties = ontologize.extractProperties(resource);
      assert.isArray(properties);
      assert.equal(properties.length, 1);
      assert.equal(properties[0]["@id"], "ex:testProperty");
    });

    it("should return empty array for non-property resource", function () {
      const resource = {
        "@id": "ex:TestClass",
        "@type": "owl:Class",
        "rdfs:label": "Test Class"
      };
      const properties = ontologize.extractProperties(resource);
      assert.isArray(properties);
      assert.equal(properties.length, 0);
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

  describe("getVersion", function () {
    it("should return version string", function () {
      const version = ontologize.getVersion();
      assert.isString(version);
      assert.equal(version, "0.1.0");
    });
  });
});
