/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * Tests for DisplayApi.getImageUrl / setImageResolver
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

/** Minimal in-memory collection mock (same shape as getSchema.test.js). */
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

function makeOntologize(opts = {}) {
  return new Ontologize(
    createMockCollection([]),
    createMockCollection([{ _id: "@id", "@context": {} }]),
    createMockCollection([]),
    { proxy: false, ...opts }
  );
}

const PHOTO = "https://example.org/img/151325.jpg";
const SPECIES_PHOTO = "https://example.org/img/bobcat.jpg";

describe("DisplayApi.getImageUrl", function() {
  let ontologize;

  beforeEach(function() {
    ontologize = makeOntologize();
  });

  it("returns the resource's own image as non-generic", async function() {
    const resource = { _id: "track:animal-151325", "bold:img": PHOTO };
    const result = await ontologize.display.getImageUrl(resource);
    assert.deepEqual(result, { url: PHOTO, generic: false, property: "bold:img" });
  });

  it("takes the first entry of an array-valued image property", async function() {
    const resource = { _id: "track:animal-1", "bold:img": [PHOTO, SPECIES_PHOTO] };
    const result = await ontologize.display.getImageUrl(resource);
    assert.deepEqual(result, { url: PHOTO, generic: false, property: "bold:img" });
  });

  it("treats empty, whitespace and non-string values as absent", async function() {
    for (const bad of ["", "   ", null, undefined, 42, { url: PHOTO }, []]) {
      const result = await ontologize.display.getImageUrl({ _id: "x", "bold:img": bad });
      assert.isNull(result, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it("returns null when there is no property and no resolver", async function() {
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.isNull(result);
  });

  it("falls back to the image resolver and keeps its generic flag", async function() {
    ontologize.display.setImageResolver(async () => ({ url: SPECIES_PHOTO, generic: true }));
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.deepEqual(result, { url: SPECIES_PHOTO, generic: true, property: null });
  });

  it("coerces a resolver's missing generic flag to false", async function() {
    ontologize.display.setImageResolver(async () => ({ url: SPECIES_PHOTO }));
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.deepEqual(result, { url: SPECIES_PHOTO, generic: false, property: null });
  });

  it("prefers the resource's own image over the resolver", async function() {
    let resolverCalled = false;
    ontologize.display.setImageResolver(async () => {
      resolverCalled = true;
      return { url: SPECIES_PHOTO, generic: true };
    });
    const resource = { _id: "track:animal-151325", "bold:img": PHOTO };
    const result = await ontologize.display.getImageUrl(resource);
    assert.deepEqual(result, { url: PHOTO, generic: false, property: "bold:img" });
    assert.isFalse(resolverCalled, "resolver must not run when the resource has its own image");
  });

  it("treats a declining resolver as no image", async function() {
    ontologize.display.setImageResolver(async () => null);
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.isNull(result);
  });

  it("catches a throwing resolver and returns null", async function() {
    ontologize.display.setImageResolver(async () => { throw new Error("boom"); });
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.isNull(result);
  });

  it("forwards opts to the resolver", async function() {
    let seen = null;
    ontologize.display.setImageResolver(async (resource, opts) => { seen = opts; return null; });
    await ontologize.display.getImageUrl({ _id: "track:animal-2" }, { lang: "en" });
    assert.deepEqual(seen, { lang: "en" });
  });

  it("honors an opts.imageProperties override", async function() {
    const custom = makeOntologize({ imageProperties: ["schema:image"] });
    const resource = { _id: "x", "schema:image": PHOTO, "bold:img": SPECIES_PHOTO };
    const result = await custom.display.getImageUrl(resource);
    assert.deepEqual(result, { url: PHOTO, generic: false, property: "schema:image" });
  });

  it("reports the matched property when the image comes from the resource", async function() {
    const resource = { _id: "x", "bold:img": PHOTO };
    const result = await ontologize.display.getImageUrl(resource);
    assert.equal(result.property, "bold:img");
  });

  it("reports a null property when the image comes from the resolver", async function() {
    ontologize.display.setImageResolver(async () => ({ url: SPECIES_PHOTO, generic: true }));
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.isNull(result.property);
  });

  it("defaults imageProperties to bold:img", function() {
    assert.deepEqual(ontologize.opts.imageProperties, ["bold:img"]);
  });

  it("does not hand out the shared DEFAULT_IMAGE_PROPERTIES array", function() {
    const other = makeOntologize();
    assert.notStrictEqual(
      ontologize.opts.imageProperties,
      Ontologize.DEFAULT_IMAGE_PROPERTIES,
      "each instance must get its own copy, or a future mutation corrupts the static"
    );
    assert.notStrictEqual(ontologize.opts.imageProperties, other.opts.imageProperties);
    assert.deepEqual(ontologize.opts.imageProperties, other.opts.imageProperties);
  });
});

describe("DisplayApi.setImageResolver", function() {
  let ontologize;

  beforeEach(function() {
    ontologize = makeOntologize();
  });

  it("rejects a value that is neither a function nor null", function() {
    assert.throws(
      () => ontologize.display.setImageResolver("nope"),
      /must be a function or null/
    );
  });

  it("clears a previously registered resolver when passed null", async function() {
    ontologize.display.setImageResolver(async () => ({ url: SPECIES_PHOTO, generic: true }));
    ontologize.display.setImageResolver(null);
    const result = await ontologize.display.getImageUrl({ _id: "track:animal-2" });
    assert.isNull(result);
  });
});
