/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Server side of the HttpCollectionAdapter wire contract.
 *
 * Host-agnostic on purpose: the handler takes a plain request descriptor and
 * returns `{ status, body }`. It knows nothing about Connect, Express, or H3.
 * Meteor mounts it through `WebApp.connectHandlers`; Nuxt mounts it in a Nitro
 * `defineEventHandler`. Both hosts share this one definition of the contract,
 * so they cannot drift.
 *
 * Contract (read-only, id-addressed):
 *   kind "doc",  GET  → one document by _id, or 404
 *   kind "docs", GET  → every document in the collection (opt-in per collection)
 *
 * No caller-supplied selectors, ever. Access is limited to the `collections`
 * allowlist, and the bulk dump requires separate opt-in via `allowBulk` —
 * intended for the small, near-immutable TBox collections only.
 *
 * Example:
 *   const handle = createCollectionHandler({
 *     collections: { ontology: () => Ontology.rawCollection() },
 *     allowBulk: ["ontology"],
 *   });
 *   const { status, body } = await handle({
 *     method: "GET", kind: "doc", collection: "ontology", id: "bold:Animal",
 *   });
 */

/**
 * @param {object} args
 * @param {object} args.collections - allowlist: name -> driver collection, or a
 *   thunk returning one (deferred resolution, as in geoCellFetcher's map)
 * @param {string[]} [args.allowBulk=[]] - collections permitted to be dumped whole
 * @returns {Function} async ({ method, kind, collection, id }) => { status, body }
 */
export function createCollectionHandler({ collections, allowBulk = [] } = {}) {
  if (!collections || typeof collections !== "object") {
    throw new Error("createCollectionHandler: a collections allowlist is required");
  }
  const bulkAllowed = new Set(allowBulk);

  function resolve(name) {
    if (!Object.prototype.hasOwnProperty.call(collections, name)) return null;
    const entry = collections[name];
    return typeof entry === "function" ? entry() : entry;
  }

  return async function handle({ method, kind, collection, id } = {}) {
    const col = resolve(collection);
    if (!col) {
      return error(404, "unknown-collection", `No collection registered as "${collection}"`);
    }

    try {
      if (kind === "doc") {
        if (method !== "GET") {
          return error(405, "method-not-allowed", "Use GET to fetch a document");
        }
        if (!id) {
          return error(400, "missing-id", "Expected /doc/<collection>/<id>");
        }
        const doc = await col.findOne({ _id: id });
        if (!doc) {
          return error(404, "not-found", `No document "${id}" in "${collection}"`);
        }
        return { status: 200, body: { doc } };
      }

      if (kind === "docs") {
        if (method !== "GET") {
          return error(405, "method-not-allowed", "Use GET to dump a collection");
        }
        if (!bulkAllowed.has(collection)) {
          return error(403, "bulk-not-allowed",
            `Collection "${collection}" is not enabled for bulk fetch`);
        }
        const docs = await col.find({}).toArray();
        return { status: 200, body: { docs } };
      }

      return error(404, "not-found", `Unrecognized request kind "${kind}"`);
    }
    catch (err) {
      return error(500, "server-error", err?.message ?? String(err));
    }
  };
}

function error(status, code, message) {
  return { status, body: { error: code, message } };
}
