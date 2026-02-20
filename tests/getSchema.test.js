/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
 *
 * Tests for Ontologize.getSchema
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

/**
 * Simple in-memory collection mock for testing
 */
function createMockCollection(initialData = []) {
  const data = new Map();
  for (const item of initialData) {
    data.set(item._id, item);
  }

  return {
    findOne: async (query) => {
      if (query._id) {
        return data.get(query._id) || null;
      }
      // Simple query matching for tests
      for (const item of data.values()) {
        let matches = true;
        for (const [key, value] of Object.entries(query)) {
          if (item[key] !== value) {
            matches = false;
            break;
          }
        }
        if (matches) return item;
      }
      return null;
    },
    find: (query = {}) => ({
      toArray: async () => {
        const results = [];
        for (const item of data.values()) {
          let matches = true;
          for (const [key, value] of Object.entries(query)) {
            if (item[key] !== value) {
              matches = false;
              break;
            }
          }
          if (matches) results.push(item);
        }
        return results;
      }
    }),
    insertOne: async (doc) => {
      data.set(doc._id, doc);
      return { insertedId: doc._id };
    },
    updateOne: async (query, update) => {
      const doc = data.get(query._id);
      if (doc && update.$set) {
        Object.assign(doc, update.$set);
      }
      return { modifiedCount: doc ? 1 : 0 };
    }
  };
}

describe("Ontologize.getSchema", function() {
  let ontologize;
  let ontologyCollection;

  // Test data matching the spec examples
  const fooProperty = {
    _id: "foo",
    "rdfs:comment": "A test property, demonstrating the BUI use of JSON Schema.",
    "@type": "owl:DatatypeProperty",
    "rdfs:range": "xsd:string",
    "bui:schema": {
      "enum": ["bar", "baz"],
      "enumLabels": ["BAR", "BAZzzzz..."]
    }
  };

  const fooBarClass = {
    _id: "FooBar",
    "@type": "rdfs:Class",
    "rdfs:comment": "A test class which overrides the default bui:schema for the `foo` property",
    "bui:schema": {
      "properties": {
        "foo": {
          "enum": ["bar", "baz", "bop"],
          "enumLabels": ["BAR", "BAZzzzz...", "BOP!"]
        }
      }
    }
  };

  const baseClass = {
    _id: "BaseClass",
    "@type": "rdfs:Class",
    "rdfs:comment": "A base class with a schema",
    "bui:schema": {
      "properties": {
        "foo": {
          "description": "From BaseClass",
          "enum": ["x", "y"]
        }
      }
    }
  };

  const derivedClass = {
    _id: "DerivedClass",
    "@type": "rdfs:Class",
    "rdfs:subClassOf": "BaseClass",
    "rdfs:comment": "A derived class that extends the base schema",
    "bui:schema": {
      "properties": {
        "foo": {
          "enum": ["x", "y", "z"],
          "title": "Foo Property"
        }
      }
    }
  };

  beforeEach(function() {
    ontologyCollection = createMockCollection([
      fooProperty,
      fooBarClass,
      baseClass,
      derivedClass
    ]);

    const contextCollection = createMockCollection([
      { _id: "@id", "@context": {} }
    ]);

    const statementsCollection = createMockCollection([]);

    ontologize = new Ontologize(ontologyCollection, contextCollection, statementsCollection);
  });

  describe("basic functionality", function() {
    it("should return empty object when no schema exists", async function() {
      const schema = await ontologize.getSchema("nonexistent");
      assert.deepEqual(schema, {});
    });

    it("should return property schema when no resource provided", async function() {
      const schema = await ontologize.getSchema("foo");
      assert.deepEqual(schema.enum, ["bar", "baz"]);
      assert.deepEqual(schema.enumLabels, ["BAR", "BAZzzzz..."]);
    });

    it("should return property schema for resource without matching class schema", async function() {
      const resource = {
        _id: "test:resource1",
        "@type": "SomeOtherClass",
        "foo": "bar"
      };
      const schema = await ontologize.getSchema("foo", resource);
      assert.deepEqual(schema.enum, ["bar", "baz"]);
      assert.deepEqual(schema.enumLabels, ["BAR", "BAZzzzz..."]);
    });
  });

  describe("class schema override", function() {
    it("should merge class schema with property schema", async function() {
      const resource = {
        _id: "test:foobarInstance",
        "@type": "FooBar",
        "foo": "bop"
      };
      const schema = await ontologize.getSchema("foo", resource);

      // Class schema should override property schema for enum/enumLabels
      assert.deepEqual(schema.enum, ["bar", "baz", "bop"]);
      assert.deepEqual(schema.enumLabels, ["BAR", "BAZzzzz...", "BOP!"]);
    });

    it("should handle resource with array of types", async function() {
      const resource = {
        _id: "test:multiType",
        "@type": ["FooBar", "SomeOtherClass"],
        "foo": "bar"
      };
      const schema = await ontologize.getSchema("foo", resource);
      assert.deepEqual(schema.enum, ["bar", "baz", "bop"]);
    });
  });

  describe("class hierarchy", function() {
    it("should walk up rdfs:subClassOf hierarchy", async function() {
      const resource = {
        _id: "test:derivedInstance",
        "@type": "DerivedClass",
        "foo": "z"
      };
      const schema = await ontologize.getSchema("foo", resource);

      // Should merge: property -> BaseClass -> DerivedClass
      // DerivedClass adds "z" to enum and adds "title"
      assert.include(schema.enum, "z");
      assert.equal(schema.title, "Foo Property");
      // BaseClass description should be present (not overridden by DerivedClass)
      assert.equal(schema.description, "From BaseClass");
    });

    it("should merge enum arrays from hierarchy", async function() {
      const resource = {
        _id: "test:derivedInstance",
        "@type": "DerivedClass",
        "foo": "z"
      };
      const schema = await ontologize.getSchema("foo", resource);

      // Property has ["bar", "baz"]
      // BaseClass has ["x", "y"]
      // DerivedClass has ["x", "y", "z"]
      // Merged result should have union of all
      assert.include(schema.enum, "bar");
      assert.include(schema.enum, "baz");
      assert.include(schema.enum, "x");
      assert.include(schema.enum, "y");
      assert.include(schema.enum, "z");
    });
  });

  describe("resource instance schema", function() {
    it("should apply resource instance bui:schema as most specific", async function() {
      // Resource with its own bui:schema that overrides property schema
      const resource = {
        _id: "test:instanceWithSchema",
        "@type": "SomeClass",
        "foo": "custom",
        "bui:schema": {
          "properties": {
            "foo": {
              "enum": ["custom", "values"],
              "instanceOverride": true
            }
          }
        }
      };
      const schema = await ontologize.getSchema("foo", resource);

      // Instance schema should be merged on top
      assert.include(schema.enum, "custom");
      assert.include(schema.enum, "values");
      assert.isTrue(schema.instanceOverride);
      // Property schema enum values should also be present (merged)
      assert.include(schema.enum, "bar");
      assert.include(schema.enum, "baz");
    });

    it("should work like the DWC ontology example with format: markdown", async function() {
      // Example from dwc.jsonld: owl:Ontology with bui:schema for dc:description
      const dwcOntology = {
        _id: "https://ontologize.2wav.com/ontology/dwc#",
        "@type": ["owl:Ontology"],
        "dcterms:title": "Darwin Core",
        "dcterms:description": "# Darwin Core\nSome markdown content...",
        "bui:schema": {
          "properties": {
            "dcterms:description": {
              "format": "markdown"
            }
          }
        }
      };

      const schema = await ontologize.getSchema("dcterms:description", dwcOntology);
      assert.equal(schema.format, "markdown");
    });

    it("should merge instance schema with class schema", async function() {
      // Resource with FooBar class (which has bui:schema) AND its own instance schema
      const resource = {
        _id: "test:foobarWithInstance",
        "@type": "FooBar",
        "foo": "instance-value",
        "bui:schema": {
          "properties": {
            "foo": {
              "customField": "from-instance"
            }
          }
        }
      };
      const schema = await ontologize.getSchema("foo", resource);

      // Should have class schema values
      assert.include(schema.enum, "bop");
      // Should have instance schema values
      assert.equal(schema.customField, "from-instance");
    });

    it("should ignore resource bui:schema when property not in properties", async function() {
      const resource = {
        _id: "test:noMatchingProp",
        "@type": "SomeClass",
        "bui:schema": {
          "properties": {
            "otherProperty": {
              "format": "date"
            }
          }
        }
      };
      const schema = await ontologize.getSchema("foo", resource);

      // Should only have property schema, not instance schema for otherProperty
      assert.deepEqual(schema.enum, ["bar", "baz"]);
      assert.isUndefined(schema.format);
    });
  });

  describe("_isClassResource", function() {
    it("should identify rdfs:Class", function() {
      assert.isTrue(ontologize._isClassResource({ "@type": "rdfs:Class" }));
    });

    it("should identify owl:Class", function() {
      assert.isTrue(ontologize._isClassResource({ "@type": "owl:Class" }));
    });

    it("should identify class in array of types", function() {
      assert.isTrue(ontologize._isClassResource({ "@type": ["owl:Class", "other:Type"] }));
    });

    it("should return false for non-class", function() {
      assert.isFalse(ontologize._isClassResource({ "@type": "owl:DatatypeProperty" }));
    });

    it("should return false for resource without @type", function() {
      assert.isFalse(ontologize._isClassResource({ "_id": "test" }));
    });
  });

  describe("_mergeSchemas", function() {
    it("should merge simple objects", function() {
      const base = { a: 1, b: 2 };
      const override = { b: 3, c: 4 };
      const result = ontologize._mergeSchemas(base, override);
      assert.deepEqual(result, { a: 1, b: 3, c: 4 });
    });

    it("should merge arrays using union", function() {
      const base = { arr: [1, 2] };
      const override = { arr: [2, 3] };
      const result = ontologize._mergeSchemas(base, override);
      assert.sameMembers(result.arr, [1, 2, 3]);
    });

    it("should recursively merge nested objects", function() {
      const base = { nested: { a: 1, b: 2 } };
      const override = { nested: { b: 3, c: 4 } };
      const result = ontologize._mergeSchemas(base, override);
      assert.deepEqual(result.nested, { a: 1, b: 3, c: 4 });
    });

    it("should handle array merged with single value", function() {
      const base = { arr: [1, 2] };
      const override = { arr: 3 };
      const result = ontologize._mergeSchemas(base, override);
      assert.sameMembers(result.arr, [1, 2, 3]);
    });
  });

  describe("_findSchemasWithProperty", function() {
    it("should find property definition", async function() {
      const schemas = await ontologize._findSchemasWithProperty(undefined, "foo", "bui:schema");
      assert.lengthOf(schemas, 1);
      assert.equal(schemas[0]._id, "foo");
    });

    it("should find class schemas for resource", async function() {
      const resource = { "@type": "FooBar" };
      const schemas = await ontologize._findSchemasWithProperty(resource, "foo", "bui:schema");

      // Should find: property "foo" and class "FooBar"
      const ids = schemas.map(s => s._id);
      assert.include(ids, "foo");
      assert.include(ids, "FooBar");
    });

    it("should walk up class hierarchy", async function() {
      const resource = { "@type": "DerivedClass" };
      const schemas = await ontologize._findSchemasWithProperty(resource, "foo", "bui:schema");

      const ids = schemas.map(s => s._id);
      assert.include(ids, "foo");
      assert.include(ids, "DerivedClass");
      assert.include(ids, "BaseClass");
    });
  });
});

describe("Ontologize group methods", function() {
  let ontologize;
  let ontologyCollection;

  // Classes with group strategies
  const trackingReportClass = {
    _id: "bold:TrackingReport",
    "@type": "rdfs:Class",
    "bui:schema": {
      "groups": [
        { "label": "Individuals", "property": "bold:animal" },
        { "label": "Species", "property": "bold:species" }
      ]
    }
  };

  const animalClass = {
    _id: "bold:Animal",
    "@type": "rdfs:Class",
    "bui:schema": {
      "groups": [
        { "label": "Species", "property": "bold:species" }
      ]
    }
  };

  const collarReportClass = {
    _id: "track:CollarReport",
    "@type": "rdfs:Class",
    "rdfs:subClassOf": "bold:TrackingReport"
    // No bui:schema — inherits from TrackingReport
  };

  const noGroupsClass = {
    _id: "test:Plain",
    "@type": "rdfs:Class",
    "rdfs:comment": "A class with no group strategies"
  };

  // Sample resources
  const resources = [
    { _id: "r1", "@type": "track:CollarReport", "bold:animal": "animal:A", "bold:species": "species:Coyote" },
    { _id: "r2", "@type": "track:CollarReport", "bold:animal": "animal:A", "bold:species": "species:Coyote" },
    { _id: "r3", "@type": "track:CollarReport", "bold:animal": "animal:B", "bold:species": "species:Fox" },
    { _id: "r4", "@type": "track:CollarReport", "bold:animal": null, "bold:species": "species:Fox" },
    { _id: "r5", "@type": "track:CollarReport" }
  ];

  beforeEach(function() {
    ontologyCollection = createMockCollection([
      trackingReportClass,
      animalClass,
      collarReportClass,
      noGroupsClass
    ]);

    const contextCollection = createMockCollection([
      { _id: "@id", "@context": {} }
    ]);

    const statementsCollection = createMockCollection([]);

    ontologize = new Ontologize(ontologyCollection, contextCollection, statementsCollection);
  });

  describe("getGroupStrategies", function() {
    it("should return groups from class schema", async function() {
      const resource = { "@type": "bold:TrackingReport" };
      const strategies = await ontologize.getGroupStrategies(resource);
      assert.lengthOf(strategies, 2);
      assert.equal(strategies[0].label, "Individuals");
      assert.equal(strategies[0].property, "bold:animal");
      assert.equal(strategies[1].label, "Species");
      assert.equal(strategies[1].property, "bold:species");
    });

    it("should inherit groups from superclass", async function() {
      const resource = { "@type": "track:CollarReport" };
      const strategies = await ontologize.getGroupStrategies(resource);
      assert.isAbove(strategies.length, 0);
      const props = strategies.map(s => s.property);
      assert.include(props, "bold:animal");
      assert.include(props, "bold:species");
    });

    it("should deduplicate by property name", async function() {
      const resource = { "@type": "track:CollarReport" };
      const strategies = await ontologize.getGroupStrategies(resource);
      const props = strategies.map(s => s.property);
      const uniqueProps = [...new Set(props)];
      assert.equal(props.length, uniqueProps.length);
    });

    it("should return empty array when no groups defined", async function() {
      const resource = { "@type": "test:Plain" };
      const strategies = await ontologize.getGroupStrategies(resource);
      assert.isArray(strategies);
      assert.lengthOf(strategies, 0);
    });
  });

  describe("groupResources", function() {
    it("should group by property", function() {
      const group = { label: "Individuals", property: "bold:animal" };
      const map = ontologize.groupResources(resources, group);
      assert.isTrue(map.has("animal:A"));
      assert.isTrue(map.has("animal:B"));
      assert.lengthOf(map.get("animal:A"), 2);
      assert.lengthOf(map.get("animal:B"), 1);
    });

    it("should put ungrouped resources in null bucket", function() {
      const group = { label: "Individuals", property: "bold:animal" };
      const map = ontologize.groupResources(resources, group);
      assert.isTrue(map.has(null));
      // r4 has null animal, r5 has no animal
      assert.lengthOf(map.get(null), 2);
    });

    it("should exclude ungrouped when includeUngrouped is false", function() {
      const group = { label: "Individuals", property: "bold:animal" };
      const map = ontologize.groupResources(resources, group, { includeUngrouped: false });
      assert.isFalse(map.has(null));
      assert.equal(map.size, 2);
    });

    it("should group by species property", function() {
      const group = { label: "Species", property: "bold:species" };
      const map = ontologize.groupResources(resources, group);
      assert.isTrue(map.has("species:Coyote"));
      assert.isTrue(map.has("species:Fox"));
      assert.lengthOf(map.get("species:Coyote"), 2);
      assert.lengthOf(map.get("species:Fox"), 2);
    });
  });

  describe("buildGroupOptions", function() {
    it("should return options with labels, colors, and counts", async function() {
      const group = { label: "Individuals", property: "bold:animal" };
      const options = await ontologize.buildGroupOptions(resources, group);
      assert.isArray(options);
      // animal:A, animal:B, plus "No Group"
      assert.lengthOf(options, 3);

      const animalA = options.find(o => o._id === "animal:A");
      assert.isOk(animalA);
      assert.equal(animalA.count, 2);
      assert.isString(animalA.color);
      assert.isString(animalA.label);
    });

    it("should append 'No Group' entry with neutral color", async function() {
      const group = { label: "Individuals", property: "bold:animal" };
      const options = await ontologize.buildGroupOptions(resources, group);
      const noGroup = options.find(o => o._id === null);
      assert.isOk(noGroup);
      assert.equal(noGroup.label, "No Group");
      assert.equal(noGroup.color, "#cccccc");
      assert.equal(noGroup.count, 2);
    });

    it("should not include 'No Group' when all resources have group values", async function() {
      const groupedResources = resources.filter(r => r["bold:species"]);
      const group = { label: "Species", property: "bold:species" };
      const options = await ontologize.buildGroupOptions(groupedResources, group);
      const noGroup = options.find(o => o._id === null);
      assert.isNotOk(noGroup);
    });
  });
});
