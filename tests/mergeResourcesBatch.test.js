/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { OntologizeServer } from "../src/OntologizeServer.js";
import { MeteorCollectionAdapter } from "../src/adapters/MeteorCollectionAdapter.js";

/**
 * `mergeResourcesBatch` exists only to compact many merges in one `ld.compact`
 * call instead of one call each. The property that matters is therefore
 * equivalence: for the same input it must return what `mergeResources` returns,
 * one group at a time. These tests assert that directly rather than restating
 * the expected shape, so they keep holding if the merge rules change.
 */
describe("Ontologize.mergeResourcesBatch", function () {
  let ontologize;

  const CONTEXT = {
    _id: "@context",
    "@context": {
      "@vocab": "https://ontologize.2wav.com/ontology/bold#",
      "bfo": "https://ontologize.2wav.com/ontology/bfo#",
      "owl": "http://www.w3.org/2002/07/owl#",
      "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
      "dcterms": "http://purl.org/dc/terms/"
    }
  };

  // `rdfs:subClassOf` is declared a set here so the ensureArrayProps step has
  // something to actually do — a single-valued occurrence of it must come back
  // wrapped in an array. Without a set-valued property in the fixture, an
  // equivalence test passes even if the batch path skips that step entirely.
  const ONTOLOGY_DOCS = {
    "rdfs:subClassOf": {
      _id: "rdfs:subClassOf",
      "@type": ["owl:ObjectProperty"],
      "bold:container": "@set"
    }
  };

  beforeEach(async function () {
    const empty = {
      findOne: async () => null,
      find: () => ({ toArray: async () => [], fetch: () => [] }),
      insertOne: async () => ({}),
      replaceOne: async () => ({ modifiedCount: 0 }),
      updateOne: async () => ({ modifiedCount: 0 }),
      count: () => 0
    };
    const ontologyCollection = {
      ...empty,
      findOne: async (q) => ONTOLOGY_DOCS[q._id] || null
    };
    const contextCollection = {
      ...empty,
      findOne: async (q) => (q._id === "@context" || q._id === "@id" ? CONTEXT : null)
    };

    ontologize = new OntologizeServer(
      new MeteorCollectionAdapter(ontologyCollection, "ontology"),
      new MeteorCollectionAdapter(contextCollection, "context"),
      new MeteorCollectionAdapter({ ...empty }, "statements")
    );
    await ontologize.ready();
  });

  const groupsFixture = () => [
    [
      { _id: "bfo:entity", "@type": ["owl:Class"], "rdfs:label": "entity" },
      { _id: "bfo:entity", "@type": ["owl:Class", "owl:Thing"], "rdfs:comment": "anything that exists" }
    ],
    [
      { _id: "bfo:continuant", "@type": ["owl:Class"], "rdfs:subClassOf": ["bfo:entity"] },
      { _id: "bfo:continuant", "rdfs:subClassOf": ["bfo:thing"], "rdfs:label": "continuant" }
    ],
    [
      { _id: "bfo:occurrent", "@type": ["owl:Class"], "rdfs:label": "occurrent" }
    ],
    // Single-valued set property: exercises the ensureArrayProps step.
    [
      { _id: "bfo:quality", "@type": ["owl:Class"], "rdfs:subClassOf": "bfo:entity" }
    ]
  ];

  it("returns what mergeResources returns, group for group", async function () {
    const groups = groupsFixture();

    const one = [];
    for (const g of groups) {
      one.push(await ontologize.mergeResources(g.map((r) => ({ ...r })), { mergeArrays: true }));
    }
    const many = await ontologize.mergeResourcesBatch(
      groups.map((g) => g.map((r) => ({ ...r }))), { mergeArrays: true }
    );

    assert.equal(many.length, one.length);
    for (let i = 0; i < one.length; i++) {
      assert.deepEqual(many[i], one[i], `group ${i} differs`);
    }
  });

  it("keeps results positionally aligned with the input groups", async function () {
    const many = await ontologize.mergeResourcesBatch(
      groupsFixture().map((g) => g.map((r) => ({ ...r }))), { mergeArrays: true }
    );
    assert.deepEqual(many.map((r) => r._id || r["@id"]),
      ["bfo:entity", "bfo:continuant", "bfo:occurrent", "bfo:quality"]);
  });

  it("merges property values across a group, not just the first resource", async function () {
    const [merged] = await ontologize.mergeResourcesBatch([[
      { _id: "bfo:entity", "@type": ["owl:Class"], "rdfs:label": "entity" },
      { _id: "bfo:entity", "rdfs:comment": "anything that exists" }
    ]], { mergeArrays: true });

    assert.equal(merged._id, "bfo:entity");
    assert.include(JSON.stringify(merged["rdfs:label"]), "entity");
    assert.include(JSON.stringify(merged["rdfs:comment"]), "anything that exists");
  });

  it("treats a single-valued set property exactly as mergeResources does", async function () {
    const r = { _id: "bfo:quality", "@type": ["owl:Class"], "rdfs:subClassOf": "bfo:entity" };
    const one = await ontologize.mergeResources([{ ...r }], { mergeArrays: true });
    const [many] = await ontologize.mergeResourcesBatch([[{ ...r }]], { mergeArrays: true });

    assert.deepEqual(many, one);
  });

  it("agrees with mergeResources with the pre-pass on as well as off", async function () {
    // `preEnsureArrayProps` defaults off. Whatever it does, the batch form must
    // do the same thing as the single form — that equivalence is the contract,
    // independent of which way the flag is set.
    const groups = groupsFixture();

    for (const preEnsureArrayProps of [true, false]) {
      const opts = { mergeArrays: true, preEnsureArrayProps };
      const one = [];
      for (const g of groups) {
        one.push(await ontologize.mergeResources(g.map((r) => ({ ...r })), opts));
      }
      const many = await ontologize.mergeResourcesBatch(
        groups.map((g) => g.map((r) => ({ ...r }))), opts
      );
      for (let i = 0; i < one.length; i++) {
        assert.deepEqual(many[i], one[i], `group ${i} differs with preEnsureArrayProps=${preEnsureArrayProps}`);
      }
    }
  });

  it("does not run the pre-pass unless preEnsureArrayProps is set", async function () {
    let calls = 0;
    const orig = ontologize._ensureArrayProps.bind(ontologize);
    ontologize._ensureArrayProps = (...a) => { calls += 1; return orig(...a); };

    const group = [
      { _id: "bfo:quality", "@type": ["owl:Class"], "rdfs:subClassOf": "bfo:entity" },
      { _id: "bfo:quality", "rdfs:label": "quality" }
    ];
    await ontologize.mergeResourcesBatch([group.map((r) => ({ ...r }))], { mergeArrays: true });
    assert.equal(calls, 0, "pre-pass should be off by default");

    await ontologize.mergeResourcesBatch([group.map((r) => ({ ...r }))],
      { mergeArrays: true, preEnsureArrayProps: true });
    assert.equal(calls, 1, "pre-pass should run when explicitly enabled");
  });

  it("returns an empty array for no groups", async function () {
    assert.deepEqual(await ontologize.mergeResourcesBatch([]), []);
  });

  it("handles single-resource groups", async function () {
    const many = await ontologize.mergeResourcesBatch([
      [{ _id: "bfo:entity", "@type": ["owl:Class"], "rdfs:label": "entity" }]
    ], { mergeArrays: true });
    assert.equal(many.length, 1);
    assert.equal(many[0]._id, "bfo:entity");
  });

  it("skips compaction when compact is false", async function () {
    const many = await ontologize.mergeResourcesBatch([[
      { _id: "bfo:entity", "@type": ["owl:Class"], "rdfs:label": "entity" },
      { _id: "bfo:entity", "rdfs:comment": "c" }
    ]], { mergeArrays: true, compact: false });

    assert.equal(many.length, 1);
    assert.equal(many[0]["rdfs:label"], "entity");
    assert.equal(many[0]["rdfs:comment"], "c");
  });

  it("throws on an empty group rather than writing a bare id", async function () {
    try {
      await ontologize.mergeResourcesBatch([[]]);
      assert.fail("Should have thrown an error");
    }
    catch (error) {
      assert.include(error.message, "Cannot merge empty array of resources");
    }
  });

  it("rejects a group whose resources disagree about their id", async function () {
    try {
      await ontologize.mergeResourcesBatch([[
        { _id: "bfo:entity", "rdfs:label": "entity" },
        { _id: "bfo:occurrent", "rdfs:label": "occurrent" }
      ]]);
      assert.fail("Should have thrown an error");
    }
    catch (error) {
      assert.include(error.message, "must have the same ID");
    }
  });
});
