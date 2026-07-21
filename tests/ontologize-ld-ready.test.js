/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

const CONTEXT_DOC = { _id: "@id", "bold": "http://bold.2wav.io/ontology#" };

/** Collection whose findOne resolves asynchronously (HTTP / Meteor adapter). */
function asyncCollection(doc) {
  return { findOne: async () => doc };
}

/** Collection whose findOne returns synchronously (plain in-memory store). */
function syncCollection(doc) {
  return { findOne: () => doc };
}

function build(contextCollection) {
  return new Ontologize(
    asyncCollection(null),
    contextCollection,
    asyncCollection(null)
  );
}

describe("Ontologize LD readiness", function () {

  describe("with an async context collection", function () {
    it("resolves ready() and builds LD with the fetched context", async function () {
      const o = build(asyncCollection(CONTEXT_DOC));
      await o.ready();
      assert.equal(o.ld().opts.context["bold"], CONTEXT_DOC["bold"]);
    });

    it("returns the instance from ready() so init can be chained", async function () {
      const o = build(asyncCollection(CONTEXT_DOC));
      const result = await o.ready();
      assert.strictEqual(result, o);
    });

    it("throws a directive error when ld() is called before ready()", function () {
      const o = build(asyncCollection(CONTEXT_DOC));
      assert.throws(() => o.ld(), /ready\(\)/);
    });

    it("is idempotent — repeated ready() calls yield the same LD", async function () {
      const o = build(asyncCollection(CONTEXT_DOC));
      await o.ready();
      const first = o.ld();
      await o.ready();
      assert.strictEqual(o.ld(), first);
    });

    it("resolves ready() even when no context document exists", async function () {
      const o = build(asyncCollection(null));
      await o.ready();
      assert.isObject(o.ld());
      assert.deepEqual(o.ld().opts.context, {});
    });

    it("rejects ready() when the context fetch fails", async function () {
      const o = build({ findOne: async () => { throw new Error("network down"); } });
      try {
        await o.ready();
        assert.fail("expected ready() to reject");
      }
      catch (err) {
        assert.match(err.message, /network down/);
      }
    });
  });

  describe("with a synchronous context collection", function () {
    it("builds LD with the context immediately, without awaiting ready()", function () {
      const o = build(syncCollection(CONTEXT_DOC));
      assert.equal(o.ld().opts.context["bold"], CONTEXT_DOC["bold"]);
    });

    it("still resolves ready()", async function () {
      const o = build(syncCollection(CONTEXT_DOC));
      await o.ready();
      assert.equal(o.ld().opts.context["bold"], CONTEXT_DOC["bold"]);
    });
  });
});
