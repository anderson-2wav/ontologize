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
 * by `_id: {$in}` and honours a projection's field list.
 */
function collectionOf(docs = [], aggregateResults = []) {
  let call = 0;
  return {
    aggregate: () => ({ toArray: async () => aggregateResults[call++] ?? [] }),
    find: (selector = {}, options = {}) => ({
      toArray: async () => {
        const ids = selector?._id?.$in;
        const rows = ids ? docs.filter(d => ids.includes(d._id)) : docs;
        const fields = options.projection && Object.keys(options.projection).filter(k => options.projection[k]);
        if (!fields) return rows.map(r => ({ ...r }));
        return rows.map(r => Object.fromEntries(
          Object.entries(r).filter(([k]) => k === "_id" || fields.includes(k))
        ));
      },
    }),
  };
}

function makeApi(collections) {
  return new GeoApi({ collections });
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
      gov: collectionOf([{ _id: "gov:north", "rdfs:label": "North", "bold:spatialDepiction": NORTH_GEOMETRY }]),
    });

    const out = await api.getGroupSummary({
      queries: [{ dataCollection: "track", dataSelector: {}, resourceCollection: "animal" }],
      groupProperty: "bold:animal",
      regions: { collection: "gov", selector: { "@type": "gov:IDNRRegion" }, geometryProperty: "bold:spatialDepiction" },
    });

    assert.deepEqual(out.summary["a:1"].regions, ["gov:north"]);
    assert.deepEqual(out.regions, [{ _id: "gov:north", label: "North" }]);
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
