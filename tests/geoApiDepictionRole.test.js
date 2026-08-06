/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import {
  pickDepictionByRole,
  withDepictionRole,
  DEPICTION_ROLE_KEY
} from "../src/geo/depiction.js";

const polygon = (size) => ({
  type: "Polygon",
  coordinates: [[[0, 0], [size, 0], [size, size], [0, size], [0, 0]]]
});

const feature = (size, properties = {}) => ({
  type: "Feature",
  properties,
  geometry: polygon(size)
});

/** Minimal in-memory collection, as in geoApiMergeShapes.test.js. */
function collectionOf(docs = []) {
  return {
    findOne: (sel = {}) => docs.find(d => sel._id === undefined || d._id === sel._id) ?? null,
    find: () => ({ fetch: () => docs, toArray: () => Promise.resolve(docs) }),
    countDocuments: () => docs.length
  };
}

const ONTOLOGY = [
  {
    _id: "bold:spatialDepiction",
    "@type": ["owl:DatatypeProperty"],
    "rdfs:range": "bold:GeoJSON",
    "bold:isJsonProperty": true
  }
];

function makeOntologize(govDocs, opts = {}) {
  Ontologize._instance = null;
  return Ontologize.initialize(
    collectionOf(ONTOLOGY),
    collectionOf([]),
    collectionOf([]),
    { collections: { gov: collectionOf(govDocs) }, proxy: false, ...opts }
  );
}

describe("pickDepictionByRole", function() {
  const detail = feature(10);
  const thumb = withDepictionRole(feature(1), "thumbnail");

  it("finds the entry carrying the role", function() {
    assert.strictEqual(pickDepictionByRole([detail, thumb], "thumbnail"), thumb);
  });

  it("treats an untagged entry as the default role", function() {
    assert.strictEqual(pickDepictionByRole([detail, thumb], "detail"), detail);
  });

  it("resolves a lone untagged depiction as detail, tagged or not", function() {
    assert.strictEqual(pickDepictionByRole([detail], "detail"), detail);
    assert.strictEqual(pickDepictionByRole(detail, "detail"), detail);
  });

  it("accepts a bare object as well as an array", function() {
    assert.strictEqual(pickDepictionByRole(thumb, "thumbnail"), thumb);
  });

  it("falls back to the first entry when not strict", function() {
    assert.strictEqual(pickDepictionByRole([detail], "thumbnail"), detail);
  });

  it("answers null on a miss when strict", function() {
    // The case that matters: a caller about to ship this to a browser must not
    // receive the full-detail geometry it did not ask for.
    assert.isNull(pickDepictionByRole([detail], "thumbnail", { strict: true }));
  });

  it("still answers an untagged entry for the default role when strict", function() {
    assert.strictEqual(pickDepictionByRole([detail], "detail", { strict: true }), detail);
  });

  it("answers null for an empty or missing value", function() {
    assert.isNull(pickDepictionByRole([], "detail"));
    assert.isNull(pickDepictionByRole(null, "detail"));
    assert.isNull(pickDepictionByRole(undefined, "thumbnail", { strict: true }));
  });
});

describe("withDepictionRole", function() {
  it("tags without mutating the input", function() {
    const source = feature(10, { "rdfs:label": "Illinois" });
    const tagged = withDepictionRole(source, "thumbnail");

    assert.equal(tagged.properties[DEPICTION_ROLE_KEY], "thumbnail");
    assert.equal(tagged.properties["rdfs:label"], "Illinois", "existing properties survive");
    assert.isUndefined(source.properties[DEPICTION_ROLE_KEY], "the input is untouched");
    assert.strictEqual(tagged.geometry, source.geometry, "geometry is shared, not cloned");
  });
});

describe("GeoApi#getSpatialDepiction — depictionRole", function() {
  const detail = feature(10);
  const thumb = withDepictionRole(feature(1), "thumbnail");

  const stateWithBoth = {
    _id: "gov:state-IL",
    "@type": ["gov:State"],
    "bold:spatialDepiction": [detail, thumb]
  };
  const stateDetailOnly = {
    _id: "gov:state-XX",
    "@type": ["gov:State"],
    "bold:spatialDepiction": [detail]
  };

  it("returns the first depiction when no role is asked for", async function() {
    const onto = makeOntologize([stateWithBoth]);
    const got = await onto.geo.getSpatialDepiction(stateWithBoth);
    assert.deepEqual(got.geometry, detail.geometry);
  });

  it("returns the thumbnail when the role is asked for", async function() {
    const onto = makeOntologize([stateWithBoth]);
    const got = await onto.geo.getSpatialDepiction(stateWithBoth, { depictionRole: "thumbnail" });
    assert.deepEqual(got.geometry, thumb.geometry);
  });

  it("falls back to the first depiction on a miss when not strict", async function() {
    const onto = makeOntologize([stateDetailOnly]);
    const got = await onto.geo.getSpatialDepiction(stateDetailOnly, { depictionRole: "thumbnail" });
    assert.deepEqual(got.geometry, detail.geometry);
  });

  it("answers null on a miss when strictRole is set", async function() {
    const onto = makeOntologize([stateDetailOnly]);
    const got = await onto.geo.getSpatialDepiction(
      stateDetailOnly,
      { depictionRole: "thumbnail", strictRole: true }
    );
    assert.isNull(got);
  });

  it("reaches through an LD proxy, which collapses the array to its first value", async function() {
    // The whole reason _selectGeoValue exists: with proxy: true the resource
    // reads as a single depiction, so a naive read can never see the thumbnail.
    const onto = makeOntologize([stateWithBoth], { proxy: true });
    await onto.ready();

    const found = await onto.getResourceForId("gov:state-IL");
    assert.isNotNull(found, "the proxied resource should resolve");

    const collapsed = found.resource["bold:spatialDepiction"];
    assert.isFalse(Array.isArray(collapsed), "the proxy collapses to one value");

    const got = await onto.geo.getSpatialDepiction(
      found.resource,
      { depictionRole: "thumbnail", strictRole: true }
    );
    assert.isNotNull(got, "the thumbnail must be reachable through __raw");
    assert.deepEqual(got.geometry, thumb.geometry);
  });
});
