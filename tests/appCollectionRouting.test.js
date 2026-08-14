/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Where `app:settings` lands on bootstrap.
 *
 * Worth its own test because the answer is only otherwise observable by running
 * a full from-scratch rebuild — 20-30 minutes — and because the resolution
 * chain has three earlier rules that could plausibly claim the resource first:
 * the TBox check, `typeCollections`, and the `"*"` ABox default.
 *
 * See `.private/specs/settings-spec.md`.
 */

import { assert } from "chai";
import { OntologizeServer } from "../src/OntologizeServer.js";

const SETTINGS = {
  _id: "app:settings",
  "@type": ["rdfs:Resource"],
  "track:publicDataDelayDays": 30,
};

function stub(name) {
  return { __name: name, findOne: async () => null, find: () => ({ toArray: async () => [] }) };
}

/**
 * A server with the registered collections and the real Critter Track
 * `typeCollections`, including its `"*": "abox"` catch-all.
 */
function makeServer() {
  const server = Object.create(OntologizeServer.prototype);
  server.collections = {
    ontology: stub("ontology"), context: stub("context"), statements: stub("statements"),
    animal: stub("animal"), species: stub("species"), track: stub("track"),
    abox: stub("abox"), app: stub("app"),
  };
  server.opts = {
    typeCollections: {
      "bold:Species": "species", "bold:Animal": "animal",
      "orju:Species": "species", "orju:Bird": "animal", "*": "abox",
    },
  };
  return server;
}

describe("app:settings collection routing", function() {
  it("routes to the app collection by namespace", async function() {
    const { name } = await makeServer().getCollectionForResource(SETTINGS);
    assert.equal(name, "app");
  });

  // rdfs:Resource is not one of the TBox types (owl:Class, rdfs:Class,
  // owl:DatatypeProperty, …), so the settings singleton is ABox and never gets
  // filed with the vocabulary that declares its properties.
  it("is not mistaken for a TBox resource", async function() {
    const { name } = await makeServer().getCollectionForResource(SETTINGS);
    assert.notEqual(name, "ontology");
  });

  // The `"*"` entry is the ABox default, applied only after namespace routing.
  // If it were consulted against @type it would swallow this resource.
  it("is not swallowed by the '*' typeCollections catch-all", async function() {
    const { name } = await makeServer().getCollectionForResource(SETTINGS);
    assert.notEqual(name, "abox");
  });

  it("still falls back to abox for an ABox resource in an unregistered namespace", async function() {
    const { name } = await makeServer().getCollectionForResource({
      _id: "nope:thing", "@type": ["rdfs:Resource"],
    });
    assert.equal(name, "abox");
  });

  // The vocabulary node that ships in the same file must NOT follow the
  // settings resource into the app collection.
  it("sends the bold-app vocabulary node to the ontology collection", async function() {
    const { name } = await makeServer().getCollectionForResource({
      _id: "bold:bold-app.jsonld", "@type": ["owl:Ontology"],
    });
    assert.equal(name, "ontology");
  });
});
