/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
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

describe("Ontologize Singleton API", function () {
  // Reset singleton state before each test
  beforeEach(function () {
    Ontologize._instance = null;
  });

  // Clean up after each test
  afterEach(function () {
    Ontologize._instance = null;
  });

  describe("initialize()", function () {
    it("should create and return a singleton instance", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance = Ontologize.initialize(ontologyAdapter, contextAdapter, statementsAdapter);

      assert.instanceOf(instance, Ontologize);
      assert.strictEqual(Ontologize._instance, instance);
    });

    it("should pass options to the instance", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance = Ontologize.initialize(ontologyAdapter, contextAdapter, statementsAdapter, {
        debug: true,
        dateFormat: "yyyy-MM-dd"
      });

      assert.equal(instance.opts.debug, true);
      assert.equal(instance.opts.dateFormat, "yyyy-MM-dd");
    });

    it("should include named collections in options", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");
      const animalAdapter = new MeteorCollectionAdapter(createMockCollection(), "animal");
      const speciesAdapter = new MeteorCollectionAdapter(createMockCollection(), "species");

      const instance = Ontologize.initialize(ontologyAdapter, contextAdapter, statementsAdapter, {
        collections: {
          animal: animalAdapter,
          species: speciesAdapter
        }
      });

      assert.strictEqual(instance.collections.animal, animalAdapter);
      assert.strictEqual(instance.collections.species, speciesAdapter);
    });

    it("should replace existing instance when called again", function () {
      const ontologyAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter1 = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance1 = Ontologize.initialize(ontologyAdapter1, contextAdapter1, statementsAdapter1);

      const ontologyAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter2 = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const instance2 = Ontologize.initialize(ontologyAdapter2, contextAdapter2, statementsAdapter2);

      assert.notStrictEqual(instance1, instance2);
      assert.strictEqual(Ontologize._instance, instance2);
    });
  });

  describe("get()", function () {
    it("should throw error when not initialized", function () {
      assert.throws(
        () => Ontologize.get(),
        Error,
        "Ontologize has not been initialized. Call Ontologize.initialize() first."
      );
    });

    it("should return the singleton instance after initialization", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      const initialized = Ontologize.initialize(ontologyAdapter, contextAdapter, statementsAdapter);
      const retrieved = Ontologize.get();

      assert.strictEqual(initialized, retrieved);
    });

    it("should return the same instance on multiple calls", function () {
      const ontologyAdapter = new MeteorCollectionAdapter(createMockCollection(), "ontology");
      const contextAdapter = new MeteorCollectionAdapter(createMockCollection(), "context");
      const statementsAdapter = new MeteorCollectionAdapter(createMockCollection(), "statements");

      Ontologize.initialize(ontologyAdapter, contextAdapter, statementsAdapter);

      const first = Ontologize.get();
      const second = Ontologize.get();
      const third = Ontologize.get();

      assert.strictEqual(first, second);
      assert.strictEqual(second, third);
    });
  });
});
