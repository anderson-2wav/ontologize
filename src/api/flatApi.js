/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Back-compat "flat" API for Ontologize / OntologizeServer.
 *
 * The public surface was reorganized into namespaces (`ontologize.display.*`,
 * `ontologize.schema.*`, `ontologize.geo.*`, `ontologize.explore.*`,
 * `ontologizeServer.io.*`, `.archive.*`, `.rdf.*`, `.reasoner.*`). The former
 * flat methods (`ontologize.getLabel(...)`, etc.) remain as thin, deprecated
 * delegates so downstream projects keep working while they migrate.
 *
 * This whole file — plus the `@deprecated` entries in the `.d.ts` files — is the
 * entire removal surface. Delete it in a later release once consumers have moved
 * to the namespace API.
 *
 * The maps below are the single source of truth: they generate the delegates,
 * drive the call-site codemod, and back the delegate test in
 * `tests/flat-api.test.js`. Keeping them authoritative means the delegates and
 * the migration can never drift.
 *
 * Map value is either:
 *   - a namespace name (string) — flat method name is reused on the namespace, or
 *   - `[namespace, method]` — flat method name differs from the namespace method
 *     (e.g. `explorer` → `explore.run`).
 */

/** @type {Object.<string, string|[string, string]>} */
export const CLIENT_FLAT_API = {
  // display
  getLabel: "display",
  getLabelProperty: "display",
  getLabelFromId: "display",
  getDescription: "display",
  getDescriptionProperty: "display",
  setLabelResolver: "display",
  setInfoComponentResolver: "display",
  getInfoComponent: "display",
  formatDate: "display",
  formatDateTime: "display",
  assignIndividualColors: "display",
  fetchIndividualLabels: "display",
  groupResources: "display",
  buildGroupOptions: "display",
  // schema
  getSchema: "schema",
  isArrayProperty: "schema",
  sortTypesFn: "schema",
  getGroupStrategies: "schema",
  // geo
  getSpatialDepiction: "geo",
  getGeoJSON: "geo", // deprecated alias of getSpatialDepiction
  getSunriseSunset: "geo",
  // explore
  explorer: ["explore", "run"]
};

/** @type {Object.<string, string|[string, string]>} */
export const SERVER_FLAT_API = {
  // io
  bootstrap: "io",
  importFromFile: "io",
  importData: "io",
  loadJsonFile: "io",
  exportToFile: "io",
  exportData: "io",
  ensurePropertyContext: "io",
  // archive
  restoreFromArchive: "archive",
  dumpToArchive: "archive",
  // rdf
  getTriplesForResources: "rdf",
  createSparqlInsert: "rdf",
  assembleFactsIntoResources: "rdf",
  createStatementsForFacts: "rdf",
  // reasoner
  bootstrapReasoner: "reasoner",
  warmReasoner: "reasoner",
  ensureReasoner: "reasoner",
  checkHylar: "reasoner",
  reasonCollection: "reasoner"
};

// Track which flat methods have already warned, so each warns at most once per
// process rather than once per call.
const _warned = new Set();

/**
 * Whether deprecation warnings should be emitted. Suppressed under test so the
 * delegate test stays quiet, and overridable per-instance via
 * `opts.warnDeprecated: false`.
 *
 * @param {object} instance - the Ontologize instance the delegate ran on
 * @returns {boolean}
 */
function shouldWarn(instance) {
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "test") {
    return false;
  }
  if (instance && instance.opts && instance.opts.warnDeprecated === false) {
    return false;
  }
  return true;
}

/**
 * Emit a one-time deprecation warning for a flat method.
 * @param {object} instance
 * @param {string} flat - flat method name
 * @param {string} ns - target namespace
 * @param {string} method - target method name on the namespace
 */
function warnOnce(instance, flat, ns, method) {
  if (_warned.has(flat)) return;
  _warned.add(flat);
  if (!shouldWarn(instance)) return;
  console.warn(
    `[Ontologize] ${flat}() is deprecated; use ontologize.${ns}.${method}() instead.`
  );
}

/**
 * Install flat delegate methods onto a class prototype from a flat-API map.
 * Each delegate warns once, then forwards to the namespace method, preserving
 * arguments, `this`, and the return value (including promises).
 *
 * A flat name that still has a real method on the prototype is left untouched.
 * This lets namespaces be extracted incrementally: a method keeps working while
 * it lives on the class, and the delegate takes over only once the real method
 * has been removed (extracted into its namespace). In the finished state no real
 * method remains, so every entry installs. As a side effect, an explicitly
 * defined method always wins over a delegate of the same name.
 *
 * @param {object} proto - class prototype (e.g. `Ontologize.prototype`)
 * @param {Object.<string, string|[string, string]>} map - a *_FLAT_API map
 */
export function installFlatApi(proto, map) {
  for (const [flat, target] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(proto, flat)) continue;
    const [ns, method] = Array.isArray(target) ? target : [target, flat];
    proto[flat] = function (...args) {
      warnOnce(this, flat, ns, method);
      return this[ns][method](...args);
    };
  }
}

/**
 * Reset the one-time warning set. Test-only helper.
 */
export function _resetFlatApiWarnings() {
  _warned.clear();
}
