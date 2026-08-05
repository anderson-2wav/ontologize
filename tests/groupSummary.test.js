/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Tests for groupSummary module.
 */

import { assert } from "chai";
import { buildSummaryPipeline, mergeSummaries } from "../src/geo/groupSummary.js";

describe("buildSummaryPipeline", function() {
  it("matches the selector and groups by the group property", function() {
    const pipeline = buildSummaryPipeline({
      selector: { "@type": "track:CollarReport" },
      groupProperty: "bold:animal",
      cellField: "_h3_7",
    });

    assert.deepEqual(pipeline[0], { $match: { "@type": "track:CollarReport" } });
    assert.deepEqual(pipeline[1].$group._id, "$bold:animal");
    assert.deepEqual(pipeline[1].$group.firstMs, { $min: "$_whenMs" });
    assert.deepEqual(pipeline[1].$group.lastMs, { $max: "$_whenMs" });
    assert.deepEqual(pipeline[1].$group.count, { $sum: 1 });
    assert.deepEqual(pipeline[1].$group.cells, { $addToSet: "$_h3_7" });
  });

  it("defaults an absent selector to match-all", function() {
    const pipeline = buildSummaryPipeline({ groupProperty: "bold:animal", cellField: "_h3_7" });
    assert.deepEqual(pipeline[0], { $match: {} });
  });

  it("honours a non-default time property", function() {
    const pipeline = buildSummaryPipeline({
      groupProperty: "bold:animal", cellField: "_h3_7", timeProperty: "_observedMs",
    });
    assert.deepEqual(pipeline[1].$group.firstMs, { $min: "$_observedMs" });
  });

  it("throws when the group property is missing", function() {
    assert.throws(() => buildSummaryPipeline({ cellField: "_h3_7" }), /groupProperty/);
  });
});

describe("mergeSummaries", function() {
  const batchA = [
    { _id: "a:1", firstMs: 200, lastMs: 900, count: 3, cells: ["c1", "c2"] },
    { _id: "a:2", firstMs: 100, lastMs: 100, count: 1, cells: ["c9"] },
  ];
  const batchB = [
    { _id: "a:1", firstMs: 50, lastMs: 400, count: 2, cells: ["c2", "c3"] },
  ];

  it("unions cells and takes min/max/sum across batches", function() {
    const merged = mergeSummaries([batchA, batchB]);
    const one = merged.get("a:1");

    assert.equal(one.firstMs, 50);
    assert.equal(one.lastMs, 900);
    assert.equal(one.count, 5);
    assert.sameMembers([...one.cells], ["c1", "c2", "c3"]);
  });

  it("keeps groups that appear in only one batch", function() {
    const merged = mergeSummaries([batchA, batchB]);
    assert.equal(merged.get("a:2").count, 1);
  });

  it("drops the null group, matching getGroupResources' filter(Boolean)", function() {
    const merged = mergeSummaries([[{ _id: null, count: 7, cells: ["c1"] }]]);
    assert.equal(merged.size, 0);
  });

  it("drops null cells from documents missing the cell field", function() {
    const merged = mergeSummaries([[{ _id: "a:1", firstMs: 1, lastMs: 2, count: 2, cells: [null, "c1"] }]]);
    assert.sameMembers([...merged.get("a:1").cells], ["c1"]);
  });

  it("carries null time bounds through rather than coercing to zero", function() {
    const merged = mergeSummaries([[{ _id: "a:1", firstMs: null, lastMs: null, count: 1, cells: [] }]]);
    assert.isNull(merged.get("a:1").firstMs);
    assert.isNull(merged.get("a:1").lastMs);
  });

  it("takes the real bound when one batch has time and another does not", function() {
    const merged = mergeSummaries([
      [{ _id: "a:1", firstMs: null, lastMs: null, count: 1, cells: [] }],
      [{ _id: "a:1", firstMs: 500, lastMs: 600, count: 1, cells: [] }],
    ]);
    assert.equal(merged.get("a:1").firstMs, 500);
    assert.equal(merged.get("a:1").lastMs, 600);
  });

  it("returns an empty map for empty input", function() {
    assert.equal(mergeSummaries([]).size, 0);
    assert.equal(mergeSummaries([[], null]).size, 0);
  });
});
