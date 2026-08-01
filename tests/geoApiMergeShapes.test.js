/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

function square(x, y, size = 1) {
  return {
    type: "Feature",
    properties: { source: `${x},${y}` },
    geometry: {
      type: "Polygon",
      coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
    }
  };
}

/**
 * Minimal in-memory collection: enough for getResourceForId to find things.
 */
function collectionOf(docs = []) {
  return {
    findOne: (sel = {}) => docs.find(d => sel._id === undefined || d._id === sel._id) ?? null,
    find: () => ({ fetch: () => docs, toArray: () => Promise.resolve(docs) }),
    countDocuments: () => docs.length
  };
}

const ONTOLOGY = [
  { _id: "bold:spatialDepiction", "@type": ["owl:DatatypeProperty"], "rdfs:range": "bold:GeoJSON", "bold:isJsonProperty": true }
];

function makeOntologize(regions) {
  Ontologize._instance = null;
  return Ontologize.initialize(
    collectionOf(ONTOLOGY),
    collectionOf([]),
    collectionOf([]),
    { collections: { gov: collectionOf(regions) }, proxy: false }
  );
}

const county = (id, shape) => ({
  _id: id,
  "@type": ["gov:County"],
  "bold:spatialDepiction": Array.isArray(shape) ? shape : [shape]
});

describe("GeoApi#mergeShapes", function() {
  let ontologize;

  beforeEach(async function() {
    ontologize = makeOntologize([
      county("gov:a", square(0, 0)),
      county("gov:b", square(1, 0)),
      county("gov:far", square(20, 20)),
      // two depictions, as a real gov:County has
      county("gov:two", [square(2, 0), square(2, 0, 0.5)])
    ]);
    await ontologize.ready();
  });

  afterEach(function() {
    Ontologize._instance = null;
  });

  it("merges resources given as ids", async function() {
    const merged = await ontologize.geo.mergeShapes(["gov:a", "gov:b"]);
    const d = merged.properties["bold:mergeDiagnostics"];
    assert.equal(d.outerRings, 1);
    assert.isTrue(d.contiguous);
  });

  it("merges resources given as objects", async function() {
    const a = { _id: "x", "bold:spatialDepiction": [square(0, 0)] };
    const b = { _id: "y", "bold:spatialDepiction": [square(1, 0)] };
    const merged = await ontologize.geo.mergeShapes([a, b]);
    assert.equal(merged.properties["bold:mergeDiagnostics"].outerRings, 1);
  });

  it("passes caller properties through to the Feature", async function() {
    const merged = await ontologize.geo.mergeShapes(["gov:a", "gov:b"], {
      properties: { "rdfs:label": "Greater Chicago Area" }
    });
    assert.equal(merged.properties["rdfs:label"], "Greater Chicago Area");
  });

  it("reports non-contiguity for resources that do not touch", async function() {
    const merged = await ontologize.geo.mergeShapes(["gov:a", "gov:far"]);
    const d = merged.properties["bold:mergeDiagnostics"];
    assert.equal(d.outerRings, 2);
    assert.isFalse(d.contiguous);
  });

  it("takes the first depiction by default", async function() {
    const merged = await ontologize.geo.mergeShapes(["gov:two"]);
    // first depiction is the full 1° square, not the 0.5° one
    assert.isAbove(merged.properties["bold:mergeDiagnostics"].areaKm2, 10000);
  });

  it("honours a select function for resources with several depictions", async function() {
    const merged = await ontologize.geo.mergeShapes(["gov:two"], {
      select: (depictions) => depictions[1]
    });
    // the second depiction is a quarter of the area of the first
    assert.isBelow(merged.properties["bold:mergeDiagnostics"].areaKm2, 5000);
  });

  it("counts ids that resolve to nothing", async function() {
    const merged = await ontologize.geo.mergeShapes(["gov:a", "gov:nope"]);
    assert.equal(merged.properties["bold:mergeDiagnostics"].unresolved, 1);
  });

  it("returns null when nothing resolves", async function() {
    assert.isNull(await ontologize.geo.mergeShapes(["gov:nope", "gov:alsonope"]));
  });

  it("returns null for an empty list", async function() {
    assert.isNull(await ontologize.geo.mergeShapes([]));
  });

  it("accepts a single resource rather than a list", async function() {
    const merged = await ontologize.geo.mergeShapes("gov:a");
    assert.isObject(merged);
    assert.equal(merged.properties["bold:mergeDiagnostics"].outerRings, 1);
  });
});
