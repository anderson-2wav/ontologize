/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { latLngToCell } from "h3-js";
import { GeoApi } from "../src/api/GeoApi.js";

const CELL_NORTH = latLngToCell(42.0, -88.5, 7);
const CELL_SOUTH = latLngToCell(38.0, -88.5, 7);

const NORTH_GEOMETRY = {
  type: "Polygon",
  coordinates: [[[-90, 41], [-87, 41], [-87, 43], [-90, 43], [-90, 41]]],
};

/**
 * Minimal collection: `aggregate` replays canned rows per call, `find` filters
 * by `_id: {$in}` and by top-level field equality, and honours a projection's
 * field list.
 *
 * The equality pass exists because region selectors are `{"@type": "…"}`. A
 * fake that ignored them returned every region document to every region set,
 * which made a multi-set test report tags no real query would produce — the
 * fixture failing rather than the code.
 */
function collectionOf(docs = [], aggregateResults = []) {
  let call = 0;
  const matches = (doc, selector) => Object.entries(selector).every(([key, want]) => {
    if (key === "_id" && want?.$in) return want.$in.includes(doc._id);
    const have = doc[key];
    return Array.isArray(have) ? have.includes(want) : have === want;
  });
  return {
    aggregate: () => ({ toArray: async () => aggregateResults[call++] ?? [] }),
    find: (selector = {}, options = {}) => ({
      toArray: async () => {
        const rows = docs.filter(d => matches(d, selector ?? {}));
        const fields = options.projection && Object.keys(options.projection).filter(k => options.projection[k]);
        if (!fields) return rows.map(r => ({ ...r }));
        return rows.map(r => Object.fromEntries(
          Object.entries(r).filter(([k]) => k === "_id" || fields.includes(k))
        ));
      },
    }),
  };
}

/** Like `collectionOf`, but records every pipeline it is handed. */
function recordingCollectionOf(aggregateResults = []) {
  const pipelines = [];
  let call = 0;
  return {
    pipelines,
    aggregate: (pipeline) => {
      pipelines.push(pipeline);
      return { toArray: async () => aggregateResults[call++] ?? [] };
    },
    find: () => ({ toArray: async () => [] }),
  };
}

/**
 * A host standing in for an Ontologize instance. `publicCollection` is part of
 * the contract GeoApi relies on — it is how the public-data time window reaches
 * a read path — so the double implements it. Here it is an identity, which is
 * what a real instance returns for a collection not listed in
 * `opts.publicDataCollections`; the window itself is tested in
 * `timeWindow.test.js` and `windowedCollection.test.js`.
 */
function makeApi(collections) {
  return new GeoApi({
    collections,
    publicCollection: async name => collections[name],
  });
}

describe("GeoApi.getGroupSummary", function() {
  it("returns per-group facts with resolved centroids", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 100, lastMs: 900, count: 4, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1", "rdfs:label": "Coyote 1", "bold:spatialRange": { big: true } }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
    });

    assert.equal(out.summary["a:1"].count, 4);
    assert.equal(out.summary["a:1"].firstMs, 100);
    assert.equal(out.summary["a:1"].lastMs, 900);
    assert.lengthOf(out.summary["a:1"].cells, 1);
    assert.closeTo(out.summary["a:1"].cells[0][0], 42.0, 0.05);
    assert.deepEqual(out.resources.map(r => r._id), ["a:1"]);
  });

  it("projects the roster to the requested fields", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1", "rdfs:label": "Coyote 1", "bold:spatialRange": { big: true } }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      fields: ["rdfs:label"],
    });

    assert.deepEqual(Object.keys(out.resources[0]).sort(), ["_id", "rdfs:label"]);
  });

  it("tags regions from the region collection", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }],
                               [{ _id: "a:2", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_SOUTH] }]]),
      animal: collectionOf([{ _id: "a:1" }, { _id: "a:2" }]),
      gov: collectionOf([{ _id: "gov:north", "@type": "gov:IDNRRegion", "rdfs:label": "North", "bold:spatialDepiction": NORTH_GEOMETRY }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      regions: { collection: "gov", selector: { "@type": "gov:IDNRRegion" }, geometryProperty: "bold:spatialDepiction" },
    });

    assert.deepEqual(out.summary["a:1"].regions, ["gov:north"]);
    // The single-object form normalizes to one set keyed "region".
    assert.deepEqual(out.regions, [{ _id: "gov:north", label: "North", set: "region" }]);
    assert.isTrue(out.meta.regionsAvailable);
    assert.deepEqual(out.meta.regionSets, { region: true });
  });

  it("tags against several independent region sets at once", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
      gov: collectionOf([
        { _id: "gov:north", "@type": "gov:IDNRRegion", "rdfs:label": "North", "bold:spatialDepiction": NORTH_GEOMETRY },
        { _id: "gov:wild-1", "@type": "gov:IDNRWildlifeRegion", "rdfs:label": "Region 1", "bold:spatialDepiction": NORTH_GEOMETRY },
      ]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      regions: [
        { key: "region", collection: "gov", selector: { "@type": "gov:IDNRRegion" } },
        { key: "wildlifeRegion", collection: "gov", selector: { "@type": "gov:IDNRWildlifeRegion" } },
      ],
    });

    // Tags stay one flat list of region ids; the catalog is what separates the
    // two schemes. Both cover the same point, so the animal carries both.
    assert.deepEqual(out.summary["a:1"].regions.sort(), ["gov:north", "gov:wild-1"]);
    assert.deepEqual(
      out.regions.map(r => [r._id, r.set]).sort(),
      [["gov:north", "region"], ["gov:wild-1", "wildlifeRegion"]]
    );
    assert.deepEqual(out.meta.regionSets, { region: true, wildlifeRegion: true });
  });

  it("tags against a region carrying a [detail, thumbnail] depiction pair", async function() {
    // `bold:spatialDepiction` is multi-valued. A region with two depictions
    // stores an array, and an array has no `.type` — read raw, pointInGeometry
    // returns false for every point and the region tags nothing at all, with no
    // error anywhere. Found on the five gov:IDNRWildlifeRegion resources, which
    // are the first region docs to carry a pair.
    const thumbnail = {
      type: "Feature",
      properties: { "bold:depictionRole": "thumbnail" },
      // Deliberately somewhere else, so a pass here cannot be the thumbnail's.
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
    };
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
      gov: collectionOf([{
        _id: "gov:wild-1",
        "@type": "gov:IDNRWildlifeRegion",
        "rdfs:label": "Region 1",
        "bold:spatialDepiction": [NORTH_GEOMETRY, thumbnail],
      }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      regions: { key: "wildlifeRegion", collection: "gov", selector: {} },
    });

    assert.deepEqual(out.summary["a:1"].regions, ["gov:wild-1"]);
    assert.deepEqual(out.meta.regionSets, { wildlifeRegion: true });
  });

  it("falls back to a thumbnail when that is the only depiction", async function() {
    // ~1 km accuracy beats not tagging at all, which is why the role lookup is
    // non-strict here and strict in geo.outlines.
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
      gov: collectionOf([{
        _id: "gov:wild-1",
        "rdfs:label": "Region 1",
        "bold:spatialDepiction": [{ ...NORTH_GEOMETRY, properties: { "bold:depictionRole": "thumbnail" } }],
      }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      regions: { collection: "gov", selector: {} },
    });

    assert.deepEqual(out.summary["a:1"].regions, ["gov:wild-1"]);
  });

  it("keeps a healthy region set when another set is misconfigured", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
      gov: collectionOf([{ _id: "gov:north", "rdfs:label": "North", "bold:spatialDepiction": NORTH_GEOMETRY }]),
    });

    const realWarn = console.warn;
    console.warn = () => {};
    let out;
    try {
      out = await api.getGroupSummary({
        queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
        groupProperty: "bold:animal",
        regions: [
          { key: "region", collection: "gov", selector: {} },
          { key: "wildlifeRegion", collection: "nope", selector: {} },
        ],
      });
    }
    finally {
      console.warn = realWarn;
    }

    // The bad set is skipped; the good one still tags. This is the property the
    // per-set try/catch exists for — one bad config must not take out its neighbour.
    assert.deepEqual(out.summary["a:1"].regions, ["gov:north"]);
    assert.deepEqual(out.meta.regionSets, { region: true, wildlifeRegion: false });
    assert.isTrue(out.meta.regionsAvailable);
  });

  it("degrades region tagging when the region collection is unregistered", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1", "rdfs:label": "Coyote 1" }]),
    });

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let out;
    try {
      out = await api.getGroupSummary({
        queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
        groupProperty: "bold:animal",
        regions: { collection: "gov", selector: { "@type": "gov:IDNRRegion" } },
      });
    }
    finally {
      console.warn = realWarn;
    }

    // The roster still returns — a missing region config must never blank it.
    assert.deepEqual(out.resources.map(r => r._id), ["a:1"]);
    assert.equal(out.summary["a:1"].count, 1);
    assert.deepEqual(out.summary["a:1"].regions, []);
    assert.deepEqual(out.regions, []);
    assert.isFalse(out.meta.regionsAvailable);
    assert.isTrue(out.meta.cellsAvailable);
    assert.lengthOf(warnings, 1);
  });

  it("degrades region tagging when the region collection cannot be read", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
      gov: { find: () => ({ toArray: async () => { throw new Error("read failed"); } }) },
    });

    const realWarn = console.warn;
    console.warn = () => {};
    let out;
    try {
      out = await api.getGroupSummary({
        queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
        groupProperty: "bold:animal",
        regions: { collection: "gov", selector: {} },
      });
    }
    finally {
      console.warn = realWarn;
    }

    assert.deepEqual(out.resources.map(r => r._id), ["a:1"]);
    assert.deepEqual(out.regions, []);
    assert.isFalse(out.meta.regionsAvailable);
  });

  it("reports cellsAvailable false when no group has a cell", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 1, cells: [null] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
    });

    assert.isFalse(out.meta.cellsAvailable);
    assert.isTrue(out.meta.timeAvailable);
  });

  it("reports timeAvailable false when no group has time bounds", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: null, lastMs: null, count: 1, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
    });

    assert.isFalse(out.meta.timeAvailable);
  });

  it("steps down a resolution and flags truncation when the cell cap is exceeded", async function() {
    const many = Array.from({ length: 30 }, (_, i) => latLngToCell(41 + i * 0.01, -88, 7));
    const few  = [latLngToCell(41, -88, 5)];
    const api = makeApi({
      // First pass (res 7) returns 30 cells; the retry (res 5) returns 1.
      track: collectionOf([], [
        [{ _id: "a:1", firstMs: 1, lastMs: 2, count: 30, cells: many }],
        [{ _id: "a:1", firstMs: 1, lastMs: 2, count: 30, cells: few }],
      ]),
      animal: collectionOf([{ _id: "a:1" }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      cellRes: 7,
      maxCells: 10,
    });

    assert.isTrue(out.meta.truncated);
    assert.equal(out.meta.cellRes, 5);
    assert.equal(out.meta.cellProperty, "_h3_5");
    assert.lengthOf(out.summary["a:1"].cells, 1);
  });

  it("returns empty structures rather than throwing when nothing matches", async function() {
    const api = makeApi({ track: collectionOf([], [[]]), animal: collectionOf([]) });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
    });

    assert.deepEqual(out.resources, []);
    assert.deepEqual(out.summary, {});
    assert.equal(out.meta.groupCount, 0);
  });

  it("reports no last point unless one was asked for", async function() {
    const api = makeApi({
      track: collectionOf([], [[{ _id: "a:1", firstMs: 1, lastMs: 900, count: 2, cells: [CELL_NORTH] }]]),
      animal: collectionOf([{ _id: "a:1" }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
    });

    assert.isNull(out.summary["a:1"].lastPoint);
    assert.isNull(out.summary["a:1"].lastPointMs);
  });

  it("returns the newest position and its time when asked for a last point", async function() {
    const api = makeApi({
      track: collectionOf([], [[{
        _id: "a:1", firstMs: 1, lastMs: 900, count: 2,
        cells: [CELL_NORTH], lastPoint: [41.9518756, -88.0172475],
      }]]),
      animal: collectionOf([{ _id: "a:1" }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      includeLastPoint: true,
    });

    // Unrounded: the caller formats it. Cells round to 4dp because a cell is
    // ~1.2 km wide; a fix is a fix.
    assert.deepEqual(out.summary["a:1"].lastPoint, [41.9518756, -88.0172475]);
    assert.equal(out.summary["a:1"].lastPointMs, 900);
  });

  it("puts the last-point accumulator in the pipeline only when asked", async function() {
    const withPoint = recordingCollectionOf([[]]);
    const without   = recordingCollectionOf([[]]);

    await makeApi({ track: withPoint, animal: collectionOf([]) }).getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      includeLastPoint: true,
    });
    await makeApi({ track: without, animal: collectionOf([]) }).getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
    });

    assert.property(withPoint.pipelines[0][1].$group, "lastPoint");
    assert.notProperty(without.pipelines[0][1].$group, "lastPoint");
  });

  it("names the registered collections when one is unknown", async function() {
    const api = makeApi({ animal: collectionOf([]) });

    try {
      await api.getGroupSummary({
        queries: [{ dataCollection: "nope", dataSelector: {}, resourceCollection: "animal" }],
        groupProperty: "bold:animal",
      });
      assert.fail("expected a throw");
    }
    catch (err) {
      assert.match(err.message, /nope/);
      assert.match(err.message, /animal/);
    }
  });
});
