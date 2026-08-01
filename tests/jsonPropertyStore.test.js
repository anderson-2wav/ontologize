/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { JsonPropertyStore } from "../src/api/server/JsonPropertyStore.js";

/**
 * JsonPropertyStore only needs its owning instance for the ontology collection
 * lookup, which we bypass by seeding the id cache directly.
 */
function createStore(jsonPropertyIds = ["bold:spatialDepiction"]) {
  const store = new JsonPropertyStore({ collections: {} });
  store._jsonPropertyIdsCache = new Set(jsonPropertyIds);
  return store;
}

const FEATURE_A = { type: "Feature", properties: { NAME_LC: "cook" }, geometry: { type: "Polygon" } };
const FEATURE_B = { type: "Feature", properties: { name: "Cook" }, geometry: { type: "MultiPolygon" } };

describe("JsonPropertyStore", function() {
  describe("_parseJsonProperties", function() {
    it("parses a bare JSON string back to a POJO", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": JSON.stringify(FEATURE_A)
      });
      assert.deepEqual(out["bold:spatialDepiction"], FEATURE_A);
    });

    it("unwraps a single { @value } wrapper from ld.compact", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": { "@type": ["@json"], "@value": JSON.stringify(FEATURE_A) }
      });
      assert.deepEqual(out["bold:spatialDepiction"], FEATURE_A);
    });

    it("unwraps { @value } wrappers on every entry of a multi-valued property", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": [
          { "@type": ["@json"], "@value": JSON.stringify(FEATURE_A) },
          { "@type": ["@json"], "@value": JSON.stringify(FEATURE_B) }
        ]
      });
      assert.deepEqual(out["bold:spatialDepiction"], [FEATURE_A, FEATURE_B]);
    });

    it("parses an array of bare JSON strings", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": [JSON.stringify(FEATURE_A), JSON.stringify(FEATURE_B)]
      });
      assert.deepEqual(out["bold:spatialDepiction"], [FEATURE_A, FEATURE_B]);
    });

    it("leaves an already-parsed POJO untouched", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": [FEATURE_A, FEATURE_B]
      });
      assert.deepEqual(out["bold:spatialDepiction"], [FEATURE_A, FEATURE_B]);
    });

    it("leaves a non-JSON string as-is rather than throwing", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": "not json at all"
      });
      assert.equal(out["bold:spatialDepiction"], "not json at all");
    });

    it("tolerates a null value", async function() {
      const store = createStore();
      const out = await store._parseJsonProperties({
        _id: "gov:county-1",
        "bold:spatialDepiction": null
      });
      assert.isNull(out["bold:spatialDepiction"]);
    });
  });

  describe("_stringifyJsonProperties round-trip", function() {
    it("survives stringify then parse for a multi-valued property", async function() {
      const store = createStore();
      const resource = { _id: "gov:county-1", "bold:spatialDepiction": [FEATURE_A, FEATURE_B] };
      const stringified = await store._stringifyJsonProperties(resource);
      assert.isString(stringified["bold:spatialDepiction"][0]);
      const parsed = await store._parseJsonProperties(stringified);
      assert.deepEqual(parsed["bold:spatialDepiction"], [FEATURE_A, FEATURE_B]);
    });
  });
});
