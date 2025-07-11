import { assert } from "chai";
import { OntologizeServer } from "../src/ontologize-server.js";

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
      assert.isFunction(ontologizeServer.extractClasses);
      assert.isFunction(ontologizeServer.extractProperties);
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
  });
});
