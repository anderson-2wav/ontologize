/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { DEPICTION_ROLE_KEY } from "../src/geo/depiction.js";

/**
 * A roughly circular blob with fine radial noise on its boundary.
 *
 * Deliberately not a square with extra collinear vertices: polygon-clipping
 * drops collinear points during the union, so the merged detail would come back
 * already minimal and the two fidelities would be indistinguishable. The noise
 * here is real geometry, so it survives the merge and is what simplification
 * has to remove — the same relationship the 102 Illinois counties have to their
 * merged outline.
 */
function noisyBlob(cx, cy, radius, n = 64, noise = 0.01) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = radius + noise * Math.sin(i * 5);
    ring.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] }
  };
}

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

const part = (id, shape) => ({
  _id: id,
  "@type": ["gov:County"],
  "bold:spatialDepiction": [shape]
});

function makeOntologize(docs) {
  Ontologize._instance = null;
  return Ontologize.initialize(
    collectionOf(ONTOLOGY),
    collectionOf([]),
    collectionOf([]),
    { collections: { gov: collectionOf(docs) }, proxy: false }
  );
}

/** Total positions across every ring — Polygon and MultiPolygon alike. */
function vertexCount(f) {
  const polygons = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polygons.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
}

describe("GeoApi#buildDepictions", function() {
  const parts = [
    part("gov:a", noisyBlob(0, 0, 1)),
    part("gov:b", noisyBlob(5, 0, 1))
  ];

  it("returns detail first and thumbnail second", async function() {
    const onto = makeOntologize(parts);
    const out = await onto.geo.buildDepictions(parts, { tolerance: 0.05 });

    assert.isArray(out);
    assert.lengthOf(out, 2);
    // Order is the contract: every consumer that knows nothing about roles
    // reads value[0] and must get full detail.
    assert.isUndefined(out[0].properties[DEPICTION_ROLE_KEY], "detail is untagged");
    assert.equal(out[1].properties[DEPICTION_ROLE_KEY], "thumbnail");
  });

  it("makes the thumbnail simpler than the detail", async function() {
    const onto = makeOntologize(parts);
    const [detail, thumbnail] = await onto.geo.buildDepictions(parts, { tolerance: 0.05 });
    assert.isBelow(vertexCount(thumbnail), vertexCount(detail));
  });

  it("gives the thumbnail its own simplify diagnostics", async function() {
    const onto = makeOntologize(parts);
    const [, thumbnail] = await onto.geo.buildDepictions(parts, { tolerance: 0.05 });
    const d = thumbnail.properties["bold:simplifyDiagnostics"];
    assert.isObject(d);
    assert.equal(d.tolerance, 0.05);
    assert.isBelow(d.verticesOut, d.verticesIn);
  });

  it("does not copy the detail's merge diagnostics onto the thumbnail", async function() {
    const onto = makeOntologize(parts);
    const [detail, thumbnail] = await onto.geo.buildDepictions(parts, { tolerance: 0.05 });
    assert.isObject(detail.properties["bold:mergeDiagnostics"], "detail keeps its own");
    assert.isUndefined(
      thumbnail.properties["bold:mergeDiagnostics"],
      "merge diagnostics describe how the detail shape was built, not the thumbnail"
    );
  });

  it("carries rdfs:label onto the thumbnail so it is self-describing", async function() {
    const onto = makeOntologize(parts);
    const [, thumbnail] = await onto.geo.buildDepictions(parts, {
      tolerance: 0.05,
      properties: { "rdfs:label": "Testland" }
    });
    assert.equal(thumbnail.properties["rdfs:label"], "Testland");
  });

  it("returns detail alone when thumbnail is false", async function() {
    const onto = makeOntologize(parts);
    const out = await onto.geo.buildDepictions(parts, { thumbnail: false });
    assert.lengthOf(out, 1);
    assert.isUndefined(out[0].properties[DEPICTION_ROLE_KEY]);
  });

  it("returns null when nothing areal resolves", async function() {
    const onto = makeOntologize([]);
    assert.isNull(await onto.geo.buildDepictions(["gov:missing"]));
  });

  it("round-trips: the pair it builds is the pair getSpatialDepiction reads back", async function() {
    const onto = makeOntologize(parts);
    const pair = await onto.geo.buildDepictions(parts, { tolerance: 0.05 });

    const state = { _id: "gov:state-XX", "@type": ["gov:State"], "bold:spatialDepiction": pair };

    const asStored = await onto.geo.getSpatialDepiction(state);
    assert.deepEqual(asStored.geometry, pair[0].geometry, "a role-blind read gets detail");

    const asThumb = await onto.geo.getSpatialDepiction(
      state,
      { depictionRole: "thumbnail", strictRole: true }
    );
    assert.deepEqual(asThumb.geometry, pair[1].geometry, "a role read gets the thumbnail");
  });
});
