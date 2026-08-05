/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * Regression tests for two getLabel/getLabelProperty defects:
 *   - getLabel aliased opts.labelProperties and unshifted class overrides onto
 *     it, growing the shared list without bound and leaking one class's
 *     preference order into every other class's lookups.
 *   - getLabelProperty's last-resort fallback indexed with `array - 1` instead
 *     of `array.length - 1`, so it always returned undefined.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

function createMockCollection(initialData = []) {
  const data = new Map();
  for (const item of initialData) data.set(item._id, item);
  return {
    findOne: async (query) => (query._id ? data.get(query._id) || null : null),
    find: () => ({ toArray: async () => [...data.values()] }),
    insertOne: async (doc) => { data.set(doc._id, doc); return { insertedId: doc._id }; },
    updateOne: async () => ({ modifiedCount: 0 }),
  };
}

// A class that overrides labelProperties, mirroring orju.jsonld's Bird.
const birdClass = {
  _id: "orju:Bird",
  "@type": "rdfs:Class",
  "bui:schema": { labelProperties: ["orju:birdName"] },
};

describe("DisplayApi label-property handling", function() {
  let ontologize;

  beforeEach(function() {
    ontologize = new Ontologize(
      createMockCollection([birdClass]),
      createMockCollection([{ _id: "@id", "@context": {} }]),
      createMockCollection([]),
      { proxy: false }
    );
  });

  it("does not mutate opts.labelProperties across repeated getLabel calls", async function() {
    const before = [...ontologize.opts.labelProperties];
    const bird = { _id: "orju:bird-1", "@type": ["orju:Bird"], "orju:birdName": "Scrub Jay" };

    for (let i = 0; i < 5; i++) {
      assert.equal(await ontologize.display.getLabel(bird), "Scrub Jay");
    }

    assert.deepEqual(ontologize.opts.labelProperties, before);
  });

  it("does not leak one class's label override into another class's lookup", async function() {
    const bird = { _id: "orju:bird-1", "@type": ["orju:Bird"], "orju:birdName": "Scrub Jay" };
    await ontologize.display.getLabel(bird);

    // An unrelated resource that happens to carry the bird's label property.
    // Its own rdfs:label must still win.
    const animal = {
      _id: "track:animal-1",
      "@type": ["bold:Animal"],
      "orju:birdName": "LEAKED",
      "rdfs:label": "Bobcat 1",
    };
    assert.equal(await ontologize.display.getLabel(animal), "Bobcat 1");
  });

  it("returns the most generic label property when the resource has none", async function() {
    const bare = { _id: "track:animal-9", "@type": ["bold:Animal"] };
    const prop = await ontologize.display.getLabelProperty(bare);
    assert.equal(prop, "rdfs:label");
  });

  it("prefers an explicit fallback over the most generic label property", async function() {
    const bare = { _id: "track:animal-9", "@type": ["bold:Animal"] };
    const prop = await ontologize.display.getLabelProperty(bare, "dcterms:title");
    assert.equal(prop, "dcterms:title");
  });
});
