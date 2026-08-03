/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * `geo.updateSpatialRange` — ranging a set of individuals and storing the
 * result. The hull itself is covered by getSpatialRange.test.js; what is tested
 * here is the grouping, the accounting, and what reaches the collection.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

/**
 * Matches the equality and $in forms these tests use. Not a Mongo engine — just
 * enough for a selector to mean something in a stub collection.
 */
function matches(doc, selector = {}) {
  return Object.entries(selector).every(([key, want]) => {
    const have = doc[key];
    if (want && typeof want === "object" && Array.isArray(want.$in)) {
      const values = Array.isArray(have) ? have : [have];
      return values.some(v => want.$in.includes(v));
    }
    return Array.isArray(have) ? have.includes(want) : have === want;
  });
}

/** In-memory collection that records every write operation it is handed. */
function collectionOf(docs = []) {
  const writes = [];
  return {
    writes,
    findOne: (sel = {}) => docs.find(d => matches(d, sel)) ?? null,
    find: (sel = {}) => {
      const found = docs.filter(d => matches(d, sel));
      return { fetch: () => found, toArray: () => Promise.resolve(found) };
    },
    countDocuments: (sel = {}) => docs.filter(d => matches(d, sel)).length,
    bulkWrite: async (ops) => {
      writes.push(...ops);
      return { matchedCount: ops.length, modifiedCount: ops.length, upsertedCount: 0 };
    }
  };
}

const ONTOLOGY = [
  { _id: "bold:spatialDepiction", "@type": ["owl:DatatypeProperty"], "rdfs:range": "bold:GeoJSON", "bold:isJsonProperty": true }
];

const animal = (id, label) => ({ _id: id, "@type": ["bold:Animal"], "rdfs:label": label ?? id });

const report = (id, animalId, lng, lat) => ({
  _id: id,
  "@type": ["bold:TrackingReport"],
  "bold:animal": animalId,
  "geo:lat": lat,
  "geo:long": lng
});

/** Four corners of a box near Colorado Springs — enough for a hull. */
const CORNERS = [[-104.95, 38.88], [-104.91, 38.88], [-104.91, 38.92], [-104.95, 38.92]];

/** One report per corner, all naming the same animal. */
const reportsFor = (animalId, prefix) =>
  CORNERS.map(([lng, lat], i) => report(`demo:${prefix}-${i}`, animalId, lng, lat));

const INDIVIDUALS = { name: "Animals", collection: "demo", selector: { "@type": "bold:Animal" } };
const GEO = { name: "Reports", collection: "geo", selector: { "@type": "bold:TrackingReport" } };

/** The $set operations recorded on a stub, as {id: value} pairs. */
function setsFrom(collection, property = "bold:spatialRange") {
  const out = {};
  for (const op of collection.writes) {
    const set = op.updateOne?.update?.$set;
    if (set && property in set) out[op.updateOne.filter._id] = set[property];
  }
  return out;
}

describe("GeoApi#updateSpatialRange", function () {
  let ontologize;
  let demo;
  let geo;

  /**
   * Individuals and geo data live in separate collections here, which is the
   * general case; that they may be the same collection is incidental.
   */
  function initialize({ animals, reports }) {
    demo = collectionOf(animals);
    geo = collectionOf(reports);
    Ontologize._instance = null;
    ontologize = Ontologize.initialize(
      collectionOf(ONTOLOGY),
      collectionOf([]),
      collectionOf([]),
      { collections: { demo, geo }, proxy: false }
    );
    return ontologize.ready();
  }

  afterEach(function () {
    Ontologize._instance = null;
  });

  it("writes one Feature per individual, at bold:spatialRange", async function () {
    await initialize({
      animals: [animal("demo:animal-MA04"), animal("demo:animal-MA13")],
      reports: [...reportsFor("demo:animal-MA04", "a"), ...reportsFor("demo:animal-MA13", "b")]
    });

    const result = await ontologize.geo.updateSpatialRange({
      individuals: INDIVIDUALS, geoData: GEO
    });

    assert.equal(result.individuals, 2);
    assert.equal(result.geoResources, 8);
    assert.equal(result.updated, 2);
    assert.equal(result.skipped, 0);

    const written = setsFrom(demo);
    assert.deepEqual(Object.keys(written).sort(), ["demo:animal-MA04", "demo:animal-MA13"]);
    assert.equal(written["demo:animal-MA04"].type, "Feature");
    assert.equal(written["demo:animal-MA04"].geometry.type, "Polygon");
  });

  it("writes to the individuals collection, not the geo one", async function () {
    await initialize({
      animals: [animal("demo:animal-MA04")],
      reports: reportsFor("demo:animal-MA04", "a")
    });

    await ontologize.geo.updateSpatialRange({ individuals: INDIVIDUALS, geoData: GEO });

    assert.lengthOf(demo.writes, 1);
    assert.lengthOf(geo.writes, 0);
  });

  it("carries individualId, rdfs:label and the caller's properties", async function () {
    await initialize({
      animals: [animal("demo:animal-MA04", "MA04")],
      reports: reportsFor("demo:animal-MA04", "a")
    });

    await ontologize.geo.updateSpatialRange({
      individuals: INDIVIDUALS, geoData: GEO,
      properties: { color: "#7c3aed" }
    });

    const props = setsFrom(demo)["demo:animal-MA04"].properties;
    assert.equal(props.individualId, "demo:animal-MA04");
    assert.equal(props["rdfs:label"], "MA04");
    assert.equal(props.color, "#7c3aed");
  });

  it("always attaches diagnostics, and reports them in ranges", async function () {
    await initialize({
      animals: [animal("demo:animal-MA04")],
      reports: reportsFor("demo:animal-MA04", "a")
    });

    const result = await ontologize.geo.updateSpatialRange({
      individuals: INDIVIDUALS, geoData: GEO
    });

    const stored = setsFrom(demo)["demo:animal-MA04"];
    const diagnostics = stored.properties["bold:rangeDiagnostics"];
    assert.equal(diagnostics.distinctPositions, 4);

    assert.lengthOf(result.ranges, 1);
    assert.equal(result.ranges[0].id, "demo:animal-MA04");
    assert.equal(result.ranges[0].distinctPositions, 4);
    assert.equal(result.ranges[0].areaKm2, diagnostics.areaKm2);
    assert.equal(result.ranges[0].vertices, diagnostics.vertices);
  });

  it("skips an individual with no geo resources, and says so", async function () {
    await initialize({
      animals: [animal("demo:animal-MA04"), animal("demo:animal-MA22")],
      reports: reportsFor("demo:animal-MA04", "a")
    });

    const result = await ontologize.geo.updateSpatialRange({
      individuals: INDIVIDUALS, geoData: GEO
    });

    assert.equal(result.updated, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.cleared, 0);
    assert.equal(result.skippedReasons["demo:animal-MA22"], "no geo resources");
    assert.isUndefined(setsFrom(demo)["demo:animal-MA22"]);
  });

  it("skips an individual with too few distinct positions, and counts them", async function () {
    await initialize({
      animals: [animal("demo:animal-MA31")],
      reports: [
        report("demo:r-1", "demo:animal-MA31", -104.95, 38.88),
        report("demo:r-2", "demo:animal-MA31", -104.91, 38.88),
        report("demo:r-3", "demo:animal-MA31", -104.91, 38.88)   // a repeat
      ]
    });

    const result = await ontologize.geo.updateSpatialRange({
      individuals: INDIVIDUALS, geoData: GEO
    });

    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedReasons["demo:animal-MA31"], "2 distinct positions");
    assert.lengthOf(demo.writes, 0);
  });

  it("throws on an unknown collection rather than ranging nothing", async function () {
    await initialize({ animals: [animal("demo:animal-MA04")], reports: [] });

    try {
      await ontologize.geo.updateSpatialRange({
        individuals: { name: "Nope", collection: "nope", selector: {} },
        geoData: GEO
      });
      assert.fail("expected updateSpatialRange to throw");
    }
    catch (e) {
      assert.match(e.message, /unknown collection "nope"/);
    }
  });

  it("writes to the property it is told to", async function () {
    await initialize({
      animals: [animal("demo:animal-MA04")],
      reports: reportsFor("demo:animal-MA04", "a")
    });

    await ontologize.geo.updateSpatialRange({
      individuals: INDIVIDUALS, geoData: GEO,
      property: "demo:summerRange"
    });

    assert.isUndefined(setsFrom(demo, "bold:spatialRange")["demo:animal-MA04"]);
    assert.isObject(setsFrom(demo, "demo:summerRange")["demo:animal-MA04"]);
  });
});
