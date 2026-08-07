/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { withDepictionRole } from "../src/geo/depiction.js";
import { geometryBbox, pointInBbox } from "../src/geo/pointInPolygon.js";

/** An axis-aligned square Feature, [lng, lat]. */
function squareFeature(minLng, minLat, size, properties = {}) {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [[
        [minLng, minLat],
        [minLng + size, minLat],
        [minLng + size, minLat + size],
        [minLng, minLat + size],
        [minLng, minLat]
      ]]
    }
  };
}

/** Minimal in-memory collection, as in geoApiDepictionRole.test.js. */
function collectionOf(docs = []) {
  const collection = {
    reads: 0,
    findOne: (sel = {}) => docs.find(d => sel._id === undefined || d._id === sel._id) ?? null,
    find: () => {
      collection.reads++;
      return { fetch: () => docs, toArray: () => Promise.resolve(docs) };
    },
    countDocuments: () => docs.length
  };
  return collection;
}

const ONTOLOGY = [
  {
    _id: "bold:spatialDepiction",
    "@type": ["owl:DatatypeProperty"],
    "rdfs:range": "bold:GeoJSON",
    "bold:isJsonProperty": true
  }
];

function makeOntologize(gov, opts = {}) {
  Ontologize._instance = null;
  return Ontologize.initialize(
    collectionOf(ONTOLOGY),
    collectionOf([]),
    collectionOf([]),
    { collections: gov ? { gov } : {}, proxy: false, ...opts }
  );
}

// Detail is deliberately larger than the thumbnail, and only the thumbnail
// carries `simplified`, so a test can tell which one came back.
const SQUARE = {
  _id: "test:state-square",
  "@type": ["gov:State"],
  "rdfs:label": "Squareland",
  "bold:spatialDepiction": [
    squareFeature(0, 0, 10),
    withDepictionRole(squareFeature(0, 0, 10, { simplified: true }), "thumbnail")
  ]
};
const FAR = {
  _id: "test:state-far",
  "@type": ["gov:State"],
  "rdfs:label": "Farland",
  "bold:spatialDepiction": [
    squareFeature(100, 0, 10),
    withDepictionRole(squareFeature(100, 0, 10), "thumbnail")
  ]
};
const NO_THUMB = {
  _id: "test:state-nothumb",
  "@type": ["gov:State"],
  "rdfs:label": "Detailonly",
  "bold:spatialDepiction": [squareFeature(-50, 0, 10)]
};

describe("geometryBbox / pointInBbox", function() {
  it("boxes a Polygon Feature", function() {
    assert.deepEqual(geometryBbox(squareFeature(1, 2, 3)), [1, 2, 4, 5]);
  });

  it("boxes a bare geometry as readily as a Feature", function() {
    assert.deepEqual(geometryBbox(squareFeature(1, 2, 3).geometry), [1, 2, 4, 5]);
  });

  it("spans every polygon of a MultiPolygon", function() {
    const bbox = geometryBbox({
      type: "MultiPolygon",
      coordinates: [
        squareFeature(0, 0, 1).geometry.coordinates,
        squareFeature(10, 10, 1).geometry.coordinates
      ]
    });
    assert.deepEqual(bbox, [0, 0, 11, 11]);
  });

  it("ignores holes, which cannot widen the box", function() {
    const outer = squareFeature(0, 0, 10).geometry.coordinates[0];
    const hole = squareFeature(2, 2, 2).geometry.coordinates[0];
    assert.deepEqual(geometryBbox({ type: "Polygon", coordinates: [outer, hole] }), [0, 0, 10, 10]);
  });

  it("answers null for anything non-areal rather than throwing", function() {
    assert.isNull(geometryBbox({ type: "Point", coordinates: [1, 2] }));
    assert.isNull(geometryBbox(null));
    assert.isNull(geometryBbox({ type: "Polygon" }));
  });

  it("includes the edges", function() {
    assert.isTrue(pointInBbox([1, 2], [1, 2, 4, 5]));
    assert.isTrue(pointInBbox([4, 5], [1, 2, 4, 5]));
    assert.isFalse(pointInBbox([4.1, 5], [1, 2, 4, 5]));
    assert.isFalse(pointInBbox([1, 2], null));
  });
});

describe("GeoApi#outline", function() {
  it("returns the thumbnail for a region by id", async function() {
    const onto = makeOntologize(collectionOf([SQUARE]));
    const out = await onto.geo.outline({ resourceId: SQUARE._id });

    assert.isNotNull(out);
    assert.equal(out._id, SQUARE._id);
    assert.equal(out.label, "Squareland");
    assert.isTrue(out.feature.properties.simplified, "must be the thumbnail, not the detail");
    assert.isUndefined(out.bbox, "the scan's bbox is an internal detail, not part of the payload");
  });

  it("resolves the region containing a point", async function() {
    const onto = makeOntologize(collectionOf([FAR, SQUARE]));
    const out = await onto.geo.outline({ point: [5, 5] });

    assert.isNotNull(out);
    assert.equal(out._id, SQUARE._id);
  });

  it("takes [lng, lat], not [lat, lng]", async function() {
    // Squareland spans lng 0..10, lat 0..10, so a swap is invisible there. This
    // fixture is asymmetric on purpose: Farland is at lng 100..110, lat 0..10,
    // and [5, 105] would only match if the pair were being swapped.
    const onto = makeOntologize(collectionOf([FAR]));
    assert.isNotNull(await onto.geo.outline({ point: [105, 5] }));
    assert.isNull(await onto.geo.outline({ point: [5, 105] }));
  });

  it("answers null when no region contains the point", async function() {
    const onto = makeOntologize(collectionOf([SQUARE, FAR]));
    assert.isNull(await onto.geo.outline({ point: [-30, -30] }));
  });

  it("answers null rather than the detail geometry when a region has no thumbnail", async function() {
    // The point is inside Detailonly. Handing back its 778 KB-equivalent detail
    // ring is exactly what strictRole exists to prevent.
    const onto = makeOntologize(collectionOf([NO_THUMB]));
    assert.isNull(await onto.geo.outline({ point: [-45, 5] }));
    assert.isNull(await onto.geo.outline({ resourceId: NO_THUMB._id }));
  });

  it("prefers resourceId over point when both are given", async function() {
    const onto = makeOntologize(collectionOf([SQUARE, FAR]));
    const out = await onto.geo.outline({ resourceId: FAR._id, point: [5, 5] });
    assert.equal(out._id, FAR._id);
  });

  it("answers null for an unknown id, a malformed point, or neither", async function() {
    const onto = makeOntologize(collectionOf([SQUARE]));
    assert.isNull(await onto.geo.outline({ resourceId: "test:state-nope" }));
    assert.isNull(await onto.geo.outline({ point: [5] }));
    assert.isNull(await onto.geo.outline({ point: ["5", "5"] }));
    assert.isNull(await onto.geo.outline({}));
  });

  it("answers null when the collection is not registered, rather than throwing", async function() {
    // A host that has not bootstrapped gov data should degrade to a rangeless
    // figure, not a 500.
    const onto = makeOntologize(null);
    assert.isNull(await onto.geo.outline({ point: [5, 5] }));
  });

  it("answers null against an empty ontology — the depiction is found by range", async function() {
    Ontologize._instance = null;
    const onto = Ontologize.initialize(
      collectionOf([]),
      collectionOf([]),
      collectionOf([]),
      { collections: { gov: collectionOf([SQUARE]) }, proxy: false }
    );
    assert.isNull(await onto.geo.outline({ point: [5, 5] }));
  });

  it("memoises resolved outlines, and clearOutlineCache drops them", async function() {
    const gov = collectionOf([SQUARE]);
    const onto = makeOntologize(gov);

    const first = await onto.geo.outline({ resourceId: SQUARE._id });
    const second = await onto.geo.outline({ resourceId: SQUARE._id });
    assert.strictEqual(second, first, "the same payload object comes back");

    onto.geo.clearOutlineCache();
    const third = await onto.geo.outline({ resourceId: SQUARE._id });
    assert.notStrictEqual(third, first, "cleared, so it was resolved again");
    assert.deepEqual(third, first);
  });

  it("reaches through an LD proxy, which collapses the depiction array", async function() {
    // With proxy: true the resource reads as a single depiction, so a naive
    // read can never see the thumbnail. This is the shape the Nitro/Meteor
    // hosts actually run in.
    const onto = makeOntologize(collectionOf([SQUARE]), { proxy: true });
    await onto.ready();

    const out = await onto.geo.outline({ point: [5, 5] });
    assert.isNotNull(out);
    assert.isTrue(out.feature.properties.simplified);
  });
});
