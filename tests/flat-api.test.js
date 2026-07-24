/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { OntologizeServer } from "../src/OntologizeServer.js";
import { CLIENT_FLAT_API, SERVER_FLAT_API } from "../src/api/flatApi.js";

// Minimal async-shaped mock collection (matches the adapter contract).
function mockCollection() {
  return {
    findOne: async () => null,
    find: () => ({ toArray: async () => [], fetch: () => [] }),
    insertOne: async () => ({ insertedId: "x" }),
    replaceOne: async () => ({ modifiedCount: 1 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    rawCollection() { return this; }
  };
}

function target(entry) {
  return Array.isArray(entry) ? entry : [entry, undefined];
}

/**
 * The flat delegates are the whole back-compat surface. This suite is what keeps
 * them honest: every entry in the flat-API maps must exist on the prototype and
 * forward — arguments, `this`, and return value intact — to its namespace method.
 * It fails loudly the moment a namespace method is renamed without updating the
 * map, protecting downstream projects that still call the flat API.
 */
describe("flat API delegates", function () {
  function checkMap(instance, map) {
    for (const [flat, entry] of Object.entries(map)) {
      const [ns, renamed] = target(entry);
      const method = renamed || flat;

      it(`${flat}() -> ${ns}.${method}()`, function () {
        // Delegate exists on the prototype
        assert.isFunction(instance[flat], `${flat} should be a delegate function`);
        // Namespace and target method exist
        assert.isObject(instance[ns], `${ns} namespace should exist`);
        assert.isFunction(instance[ns][method], `${ns}.${method} should be a function`);

        // Stub the namespace method and confirm the delegate forwards to it
        const original = instance[ns][method];
        let received = null;
        const sentinel = { forwarded: true };
        instance[ns][method] = function (...args) {
          received = { self: this, args };
          return sentinel;
        };
        try {
          const ret = instance[flat]("arg1", 2, { three: true });
          assert.strictEqual(ret, sentinel, "delegate must return the namespace method's result");
          assert.isNotNull(received, "namespace method must be invoked");
          assert.deepEqual(received.args, ["arg1", 2, { three: true }], "arguments must pass through");
          assert.strictEqual(received.self, instance[ns], "`this` must be the namespace instance");
        }
        finally {
          instance[ns][method] = original;
        }
      });
    }
  }

  describe("client (Ontologize)", function () {
    const onto = new Ontologize(mockCollection(), mockCollection(), mockCollection());
    checkMap(onto, CLIENT_FLAT_API);
  });

  describe("server (OntologizeServer)", function () {
    const server = new OntologizeServer(mockCollection(), mockCollection(), mockCollection());
    // Server inherits the client delegates too.
    checkMap(server, CLIENT_FLAT_API);
    checkMap(server, SERVER_FLAT_API);
  });
});
