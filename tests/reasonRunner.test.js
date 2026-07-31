/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * Tests for the background reasoning runner on ontologizeServer.reasoner.
 *
 * Run: meteor npm run test-ontologize
 */

import { assert } from "chai";
import { ReasonerApi } from "../src/api/server/ReasonerApi.js";

/** A collection stub counting only what the runner asks of it. */
function fakeCollection(docs = []) {
  return {
    docs,
    countDocuments: async (selector = {}) => {
      if (selector["bold:reasoned"]?.$exists === true) {
        return docs.filter(d => d["bold:reasoned"] !== undefined).length;
      }
      if (selector["bold:reasoned"]?.$exists === false) {
        return docs.filter(d => d["bold:reasoned"] === undefined).length;
      }
      return docs.length;
    },
    find: () => ({
      limit: () => ({
        toArray: async () => docs.filter(d => d["bold:reasoned"] === undefined),
      }),
    }),
  };
}

/**
 * A ReasonerApi over a stub owner. `collections` is given as an array of names
 * so registration order is explicit and readable in each test.
 */
function makeApi({ names = [], opts = {}, docsByName = {} } = {}) {
  const collections = {};
  for (const name of names) collections[name] = fakeCollection(docsByName[name] || []);
  return new ReasonerApi({ collections, opts });
}

describe("ReasonerApi reasoned-collection selection", function () {

  it("excludes ontology, context and statements", function () {
    const api = makeApi({ names: ["ontology", "context", "statements", "species", "track"] });
    assert.deepEqual(api._reasonedCollectionNames(), ["species", "track"]);
  });

  it("uses registration order when no hint is set", function () {
    const api = makeApi({ names: ["ontology", "context", "statements", "animal", "species", "orju", "track"] });
    assert.deepEqual(api._reasonedCollectionNames(), ["animal", "species", "orju", "track"]);
  });

  it("front-loads the names in reasonOrder, remainder in registration order", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "animal", "species", "orju", "track", "ngss"],
      opts: { reasonOrder: ["species", "animal"] },
    });
    assert.deepEqual(api._reasonedCollectionNames(), ["species", "animal", "orju", "track", "ngss"]);
  });

  // The property that makes a third entry unnecessary: track cannot precede
  // animal once animal is front-loaded, whatever the registration order.
  it("puts track after animal for any registration order of the remainder", function () {
    for (const rest of [["track", "orju"], ["orju", "track"], ["track"]]) {
      const api = makeApi({
        names: ["ontology", "context", "statements", ...rest, "animal", "species"],
        opts: { reasonOrder: ["species", "animal"] },
      });
      const order = api._reasonedCollectionNames();
      assert.isBelow(order.indexOf("animal"), order.indexOf("track"),
        `animal must precede track for registration ${JSON.stringify(rest)}`);
    }
  });

  it("ignores a reasonOrder name that is not a reasoned collection", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "species", "track"],
      opts: { reasonOrder: ["species", "nope", "ontology"] },
    });
    assert.deepEqual(api._reasonedCollectionNames(), ["species", "track"]);
  });

  it("still reasons a registered collection missing from reasonOrder", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "species", "demo"],
      opts: { reasonOrder: ["species"] },
    });
    assert.include(api._reasonedCollectionNames(), "demo");
  });

  it("tolerates a non-array reasonOrder", function () {
    const api = makeApi({
      names: ["ontology", "context", "statements", "species"],
      opts: { reasonOrder: "species" },
    });
    assert.deepEqual(api._reasonedCollectionNames(), ["species"]);
  });
});
