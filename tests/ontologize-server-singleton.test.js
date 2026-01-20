import { assert } from "chai";
import { OntologizeServer } from "../src/OntologizeServer.js";
import { Ontologize } from "../src/Ontologize.js";
import { MeteorCollectionAdapter } from "../src/adapters/MeteorCollectionAdapter.js";

// Helper function to create mock collections
function createMockCollection() {
  return {
    findOne: () => null,
    find: () => ({
      fetch: () => [],
      toArray: () => Promise.resolve([])
    }),
    insert: () => Promise.resolve({ insertedId: "test-id" }),
    count: () => 0
  };
}

describe("OntologizeServer Singleton API", function () {
  // Reset singleton state before each test
  beforeEach(function () {
    OntologizeServer._instance = null;
    Ontologize._instance = null;
  });

  // Clean up after each test
  afterEach(function () {
    OntologizeServer._instance = null;
    Ontologize._instance = null;
  });

  describe("initialize()", function () {
    it("should create and return a singleton instance", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance = OntologizeServer.initialize(ontologyAdapter, contextAdapter, statementsAdapter);

      assert.instanceOf(instance, OntologizeServer);
      assert.instanceOf(instance, Ontologize);
      assert.strictEqual(OntologizeServer._instance, instance);
    });

    it("should have separate instance from Ontologize", function () {
      const ontologyAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const ontologyAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const ontologizeInstance = Ontologize.initialize(ontologyAdapter1, contextAdapter1, statementsAdapter1);
      const serverInstance = OntologizeServer.initialize(ontologyAdapter2, contextAdapter2, statementsAdapter2);

      assert.notStrictEqual(ontologizeInstance, serverInstance);
      assert.strictEqual(Ontologize._instance, ontologizeInstance);
      assert.strictEqual(OntologizeServer._instance, serverInstance);
    });

    it("should pass options to the instance", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance = OntologizeServer.initialize(ontologyAdapter, contextAdapter, statementsAdapter, {
        debug: true,
        bootstrapPath: "/custom/path"
      });

      assert.equal(instance.opts.debug, true);
      assert.equal(instance.bootstrapPath, "/custom/path");
    });

    it("should include named collections in options", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");
      const trackAdapter = new MeteorCollectionAdapter(createMockCollection(), "track");
      const ngssAdapter = new MeteorCollectionAdapter(createMockCollection(), "ngss");

      const instance = OntologizeServer.initialize(ontologyAdapter, contextAdapter, statementsAdapter, {
        collections: {
          Track: trackAdapter,
          NGSS: ngssAdapter
        }
      });

      assert.strictEqual(instance.collections.Track, trackAdapter);
      assert.strictEqual(instance.collections.NGSS, ngssAdapter);
    });

    it("should replace existing instance when called again", function () {
      const ontologyAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance1 = OntologizeServer.initialize(ontologyAdapter1, contextAdapter1, statementsAdapter1);

      const ontologyAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance2 = OntologizeServer.initialize(ontologyAdapter2, contextAdapter2, statementsAdapter2);

      assert.notStrictEqual(instance1, instance2);
      assert.strictEqual(OntologizeServer._instance, instance2);
    });
  });

  describe("get()", function () {
    it("should throw error when not initialized", function () {
      assert.throws(
        () => OntologizeServer.get(),
        Error,
        "OntologizeServer has not been initialized. Call OntologizeServer.initialize() first."
      );
    });

    it("should return the singleton instance after initialization", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const initialized = OntologizeServer.initialize(ontologyAdapter, contextAdapter, statementsAdapter);
      const retrieved = OntologizeServer.get();

      assert.strictEqual(initialized, retrieved);
    });

    it("should return the same instance on multiple calls", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      OntologizeServer.initialize(ontologyAdapter, contextAdapter, statementsAdapter);

      const first = OntologizeServer.get();
      const second = OntologizeServer.get();
      const third = OntologizeServer.get();

      assert.strictEqual(first, second);
      assert.strictEqual(second, third);
    });
  });
});
