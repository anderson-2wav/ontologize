/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * The instance-bound half of `getSpatialRange`: id resolution, depiction
 * selection, and the `requested`/`unresolved` accounting. The hull geometry
 * itself is covered by `getSpatialRange.test.js` — what is tested here is
 * everything between a resource and the positions handed to it.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

/** A tracking report, as `demo.jsonld` stores one: bare `geo:lat`/`geo:long`. */
const report = (id, lng, lat) => ({
  _id: id,
  "@type": ["bold:TrackingReport"],
  "bold:animal": "demo:animal-MA04",
  "geo:lat": lat,
  "geo:long": lng
});

/** A degree square as a Feature, the shape `bold:spatialDepiction` carries. */
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

const county = (id, shape) => ({
  _id: id,
  "@type": ["gov:County"],
  "bold:spatialDepiction": Array.isArray(shape) ? shape : [shape]
});

/** Minimal in-memory collection: enough for getResourceForId to find things. */
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

function makeOntologize(collections) {
  Ontologize._instance = null;
  return Ontologize.initialize(
    collectionOf(ONTOLOGY),
    collectionOf([]),
    collectionOf([]),
    { collections, proxy: false }
  );
}

/**
 * Four reports around Colorado Springs, MA04's country — a square about 3 km on
 * a side, plus one repeat of the first position. Real collars report the same
 * spot for hours, and the repeat is what `distinctPositions` is for.
 */
const REPORTS = [
  report("demo:report-1", -104.95, 38.88),
  report("demo:report-2", -104.91, 38.88),
  report("demo:report-3", -104.91, 38.92),
  report("demo:report-4", -104.95, 38.92),
  report("demo:report-dup", -104.95, 38.88)
];

/** Two clusters with a thin neck — a concave hull should cut the neck out. */
function dumbbellReports() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    out.push(report(`demo:left-${i}`, -88 + 0.1 * Math.cos(a), 40 + 0.1 * Math.sin(a)));
    out.push(report(`demo:right-${i}`, -87 + 0.1 * Math.cos(a), 40 + 0.1 * Math.sin(a)));
  }
  return out;
}

const diag = (feature) => feature.properties["bold:rangeDiagnostics"];
const ids = (list) => list.map(r => r._id);

describe("GeoApi#getSpatialRange", function() {
  let ontologize;

  beforeEach(async function() {
    ontologize = makeOntologize({
      demo: collectionOf([
        ...REPORTS,
        // A report the collar wrote with no fix — present, but not a position.
        { _id: "demo:report-blank", "@type": ["bold:TrackingReport"], "bold:animal": "demo:animal-MA04" }
      ]),
      gov: collectionOf([
        county("gov:a", square(0, 0)),
        county("gov:b", square(1, 0)),
        // two depictions, as a real gov:County has
        county("gov:two", [square(2, 0), square(2, 0, 0.5)])
      ])
    });
    await ontologize.ready();
  });

  afterEach(function() {
    Ontologize._instance = null;
  });

  describe("resolving resources", function() {
    it("ranges resources given as ids", async function() {
      const f = await ontologize.geo.getSpatialRange(ids(REPORTS));
      assert.equal(f.type, "Feature");
      assert.equal(diag(f).requested, 5);
      assert.equal(diag(f).unresolved, 0);
      assert.equal(diag(f).distinctPositions, 4);   // the repeat counts once
    });

    it("ranges resources given as objects", async function() {
      const f = await ontologize.geo.getSpatialRange(REPORTS);
      assert.equal(diag(f).inputs, 5);
      assert.equal(diag(f).distinctPositions, 4);
    });

    it("accepts a single resource rather than a list", async function() {
      // One county is three positions and then some — a polygon's vertices are
      // positions like any other, which is the whole difference from mergeShapes.
      const f = await ontologize.geo.getSpatialRange("gov:a");
      assert.isNotNull(f);
      assert.equal(diag(f).requested, 1);
      assert.equal(diag(f).distinctPositions, 4);
    });

    it("mixes tracking points and county polygons in one range", async function() {
      const f = await ontologize.geo.getSpatialRange([...ids(REPORTS), "gov:a", "gov:b"]);
      assert.equal(diag(f).requested, 7);
      assert.equal(diag(f).unresolved, 0);
      // 4 report positions + 5 ring positions per county, closing point included
      assert.equal(diag(f).positions, 5 + 5 + 5);
    });

    /**
     * The `/geo-test?view=range` path: `geo:lat`/`geo:long` with no depiction
     * property at all, resolved by getSpatialDepiction pattern 1. Asserting the
     * ring lands in Colorado is what catches a lat/lng transposition — a
     * swapped range is a perfectly valid polygon, just off the coast of Somalia.
     */
    it("reads bare geo:lat / geo:long, in [lng, lat] order", async function() {
      const ring = (await ontologize.geo.getSpatialRange(ids(REPORTS))).geometry.coordinates[0];
      for (const [lng, lat] of ring) {
        assert.closeTo(lng, -104.93, 0.05);
        assert.closeTo(lat, 38.90, 0.05);
      }
    });
  });

  describe("what does not resolve", function() {
    it("counts ids that resolve to nothing", async function() {
      const f = await ontologize.geo.getSpatialRange([...ids(REPORTS), "demo:report-nope"]);
      assert.equal(diag(f).requested, 6);
      assert.equal(diag(f).unresolved, 1);
      // and the hull is still the four real corners
      assert.equal(diag(f).distinctPositions, 4);
    });

    it("counts resources that carry no spatial data", async function() {
      const f = await ontologize.geo.getSpatialRange([...ids(REPORTS), "demo:report-blank"]);
      assert.equal(diag(f).unresolved, 1);
    });

    it("returns null when nothing resolves", async function() {
      assert.isNull(await ontologize.geo.getSpatialRange(["demo:nope", "demo:alsonope"]));
    });

    it("returns null for an empty list", async function() {
      assert.isNull(await ontologize.geo.getSpatialRange([]));
    });

    it("returns null below three distinct positions — a collar that never moved", async function() {
      assert.isNull(await ontologize.geo.getSpatialRange(["demo:report-1", "demo:report-dup"]));
    });
  });

  describe("options reaching the hull", function() {
    it("passes caller properties through to the Feature", async function() {
      const f = await ontologize.geo.getSpatialRange(ids(REPORTS), {
        properties: { "rdfs:label": "demo:animal-MA04", color: "#7c3aed" }
      });
      assert.equal(f.properties["rdfs:label"], "demo:animal-MA04");
      assert.equal(f.properties.color, "#7c3aed");
    });

    it("forwards hullType and alpha", async function() {
      const reports = dumbbellReports();
      const convex  = await ontologize.geo.getSpatialRange(reports, { hullType: "convex" });
      const concave = await ontologize.geo.getSpatialRange(reports, { hullType: "concave", alpha: 1 });
      assert.equal(diag(concave).hullType, "concave");
      assert.equal(diag(concave).alpha, 1);
      assert.isBelow(diag(concave).areaKm2, diag(convex).areaKm2);
    });

    it("forwards winding", async function() {
      const f = await ontologize.geo.getSpatialRange(ids(REPORTS), { winding: "ccw" });
      assert.equal(diag(f).winding, "ccw");
    });

    it("omits diagnostics on request — including requested and unresolved", async function() {
      const f = await ontologize.geo.getSpatialRange([...ids(REPORTS), "demo:nope"], { diagnostics: false });
      assert.isUndefined(f.properties["bold:rangeDiagnostics"]);
    });

    it("throws an unknown hullType through the instance method", async function() {
      try {
        await ontologize.geo.getSpatialRange(ids(REPORTS), { hullType: "alpha" });
        assert.fail("expected getSpatialRange to throw");
      }
      catch (e) {
        assert.match(e.message, /unknown hullType/);
      }
    });

    it("threads an ontologyCache through the depiction lookups", async function() {
      const cache = new Map();
      await ontologize.geo.getSpatialRange(["gov:a", "gov:b"], { ontologyCache: cache });
      // One shared cache across the batch rather than a lookup per resource.
      assert.isAbove(cache.size, 0);
    });
  });

  describe("select", function() {
    it("honours a select function for resources with several depictions", async function() {
      const first  = await ontologize.geo.getSpatialRange("gov:two");
      const second = await ontologize.geo.getSpatialRange("gov:two", {
        select: (depictions) => depictions[1]
      });
      // the second depiction is half the square, so a quarter of the area
      assert.isBelow(diag(second).areaKm2, diag(first).areaKm2 / 3);
    });

    it("offers select every depiction, not just the first", async function() {
      let offered = 0;
      await ontologize.geo.getSpatialRange("gov:two", {
        select: (depictions) => { offered = depictions.length; return depictions[0]; }
      });
      assert.equal(offered, 2);
    });

    /**
     * `select` replaces getSpatialDepiction rather than refining it, so it only
     * ever sees `bold:spatialDepiction`. Reports carrying bare geo:lat/geo:long
     * therefore contribute nothing — a real trap when ranging a mixed set.
     */
    it("bypasses getSpatialDepiction, so lat/long resources go unresolved", async function() {
      const f = await ontologize.geo.getSpatialRange([...ids(REPORTS), "gov:a"], {
        select: (depictions) => depictions[0]
      });
      assert.equal(diag(f).unresolved, 5);
      assert.equal(diag(f).distinctPositions, 4);   // the county's corners alone
    });
  });
});
