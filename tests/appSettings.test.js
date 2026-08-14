/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Tests for the `app:settings` singleton — user-adjustable application
 * settings read from the graph, with deployment config as the fallback.
 *
 * See `.private/specs/settings-spec.md`.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

/** Minimal stand-ins for the three collections the constructor requires. */
function bareCollection() {
  return { findOne: async () => null, find: () => ({ toArray: async () => [] }) };
}

function appCollection(doc) {
  return {
    reads: [],
    async findOne(selector) {
      this.reads.push(selector);
      return doc;
    },
  };
}

function makeOntologize({ app, opts = {} } = {}) {
  const o = new Ontologize(bareCollection(), bareCollection(), bareCollection(), opts);
  if (app) o.collections.app = app;
  return o;
}

describe("getAppSetting", function() {
  it("reads a property off the app:settings singleton", async function() {
    const app = appCollection({ _id: "app:settings", "track:publicDataDelayDays": 45 });
    const o = makeOntologize({ app });

    assert.equal(await o.getAppSetting("track:publicDataDelayDays"), 45);
    assert.deepEqual(app.reads[0], { _id: "app:settings" });
  });

  it("is undefined when the collection is not registered", async function() {
    const o = makeOntologize();
    assert.isUndefined(await o.getAppSetting("track:publicDataDelayDays"));
  });

  it("is undefined when the singleton has not been bootstrapped", async function() {
    const o = makeOntologize({ app: appCollection(null) });
    assert.isUndefined(await o.getAppSetting("track:publicDataDelayDays"));
  });

  // A settings read is not worth taking an application down for; every caller
  // pairs it with a deployment-config fallback.
  it("is undefined rather than a throw when the read fails", async function() {
    const app = { findOne: async () => { throw new Error("mongo is down"); } };
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      assert.isUndefined(await makeOntologize({ app }).getAppSetting("x"));
    }
    finally {
      console.warn = realWarn;
    }
  });
});

describe("getPublicDataDelayDays", function() {
  it("prefers the stored setting over deployment config", async function() {
    const app = appCollection({ _id: "app:settings", "track:publicDataDelayDays": 45 });
    const o = makeOntologize({ app, opts: { publicDataDelayDays: 30 } });

    assert.equal(await o.getPublicDataDelayDays(), 45);
  });

  // Zero is how an admin turns the delay off. Read as "absent" it would fall
  // through to the settings.json default and silently refuse to switch off.
  it("honours a stored zero instead of treating it as absent", async function() {
    const app = appCollection({ _id: "app:settings", "track:publicDataDelayDays": 0 });
    const o = makeOntologize({ app, opts: { publicDataDelayDays: 30 } });

    assert.equal(await o.getPublicDataDelayDays(), 0);
  });

  it("falls back to deployment config before the collection is bootstrapped", async function() {
    const o = makeOntologize({ app: appCollection(null), opts: { publicDataDelayDays: 30 } });
    assert.equal(await o.getPublicDataDelayDays(), 30);
  });

  // A BOLD app that never adopts the settings collection must behave exactly as
  // it did before the collection existed.
  it("is zero when neither the setting nor the config is present", async function() {
    assert.equal(await makeOntologize().getPublicDataDelayDays(), 0);
  });

  it("ignores a stored value of the wrong type", async function() {
    const app = appCollection({ _id: "app:settings", "track:publicDataDelayDays": "thirty" });
    const o = makeOntologize({ app, opts: { publicDataDelayDays: 30 } });

    assert.equal(await o.getPublicDataDelayDays(), 30);
  });
});
