/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Applying the public-data time window to a collection.
 *
 * `timeWindow.js` decides *what* the window is; this decides *where* it lands.
 * Two pieces:
 *
 *   - `createWindowProvider` — resolves the current clause, caching the
 *     individuals' bounds behind a TTL.
 *   - `windowCollection` — a read-only façade over a Mongo collection that
 *     composes that clause into every query it forwards.
 *
 * **This wraps read paths only.** The reasoner, the importer and the H3
 * backfill must keep seeing the whole collection: a reasoning pass over a
 * windowed view would stamp `bold:reasoned` on the visible documents alone and
 * never revisit the rest, and an `addH3` that skipped recent documents would
 * leave them with no cell field — permanently invisible on the map even after
 * the delay released them. See `.private/specs/crittertrack/time-window-spec.md`.
 */

import { START_PROPERTY, END_PROPERTY, parseAnimalBounds, dayCutoffMs, buildWindowClause, withWindow }
  from "./timeWindow.js";

/** How long resolved bounds stay usable before being re-read. */
export const DEFAULT_TTL_MS = 60_000;

/** Read methods the façade composes the window into. */
const WINDOWED_METHODS = ["find", "findOne", "countDocuments", "distinct", "aggregate"];

/**
 * A resolver for the current window clause.
 *
 * The individuals' bounds are cached for `ttlMs`. **The TTL is the entire
 * invalidation strategy, on purpose:** WILD writes `bold:publicDataStart` /
 * `bold:publicDataEnd` straight to MongoDB without passing through this
 * application, so there is no event to invalidate on. An admin's edit takes
 * effect within one TTL.
 *
 * @param {object} opts
 * @param {object} opts.animalCollection - collection holding the individuals
 * @param {string} opts.timeZone - IANA zone the bounds' calendar fields mean
 * @param {number|function} opts.delayDays - the rolling delay, or a getter for
 *   it, so a future admin-editable setting needs no change here
 * @param {function} [opts.nowFn=Date.now] - injectable clock, for tests
 * @param {number} [opts.ttlMs=60000]
 * @param {string} [opts.groupProperty="bold:animal"]
 * @param {string} [opts.timeProperty="_whenMs"]
 * @returns {{clause: function(): Promise<object|null>, invalidate: function(): void}}
 */
export function createWindowProvider({
  animalCollection, timeZone, delayDays, nowFn = Date.now, ttlMs = DEFAULT_TTL_MS,
  groupProperty = "bold:animal", timeProperty = "_whenMs",
} = {}) {
  let cached = null;   // { bounds, days }
  let cachedAtMs = -Infinity;

  /**
   * Both inputs to the clause, under one TTL.
   *
   * The delay is cached with the bounds rather than read per query because it
   * now comes from the `app:settings` resource — a database read like the
   * bounds, and an admin edit to either should take effect on the same
   * schedule.
   */
  async function inputs() {
    const now = nowFn();
    if (cached !== null && now - cachedAtMs < ttlMs) return cached;

    // Deliberately unguarded: a failure here must propagate. Falling back to
    // "no bounds" would publish exactly the documents this module hides, and
    // it would do so silently. Fail closed, loudly.
    const docs = await animalCollection.find(
      { $or: [{ [START_PROPERTY]: { $exists: true } }, { [END_PROPERTY]: { $exists: true } }] },
      { projection: { _id: 1, [START_PROPERTY]: 1, [END_PROPERTY]: 1 } }
    ).toArray();
    // `await` on a plain number is harmless, so a caller may still pass one.
    const days = await (typeof delayDays === "function" ? delayDays() : delayDays);

    // Assigned only after the awaits resolve, so a throw leaves the previous
    // value in place and is not itself cached.
    cached = { bounds: parseAnimalBounds(docs, timeZone), days };
    cachedAtMs = now;
    return cached;
  }

  return {
    async clause() {
      const { bounds, days } = await inputs();
      return buildWindowClause({
        cutoffMs: dayCutoffMs(nowFn(), days, timeZone),
        bounds,
        groupProperty,
        timeProperty,
      });
    },
    /** Drop the cache; for tests and for an in-process settings or bounds edit. */
    invalidate() {
      cached = null;
      cachedAtMs = -Infinity;
    },
  };
}

/**
 * Compose the window into an aggregation pipeline.
 *
 * A leading `$match` absorbs the clause; anything else gets a `$match`
 * prepended. Prepending is also the right call for correctness — filtering
 * before `$group`/`$facet` is what keeps counts and time bounds honest, rather
 * than aggregating suppressed documents and hiding the result afterwards.
 *
 * (A pipeline that must open with `$geoNear` would break under this. None
 * does; every geo pipeline here starts with `$match` or a plain stage.)
 *
 * @private
 */
function windowPipeline(pipeline, clause) {
  const stages = Array.isArray(pipeline) ? pipeline : [];
  const first = stages[0];

  if (first && Object.prototype.hasOwnProperty.call(first, "$match")) {
    return [{ $match: withWindow(first.$match, clause) }, ...stages.slice(1)];
  }
  return [{ $match: clause }, ...stages];
}

/**
 * A read façade over `collection` with the window composed into every query.
 *
 * Async because the clause has to be resolved before a synchronous `find()`
 * can be answered — callers `await` the collection once, then use it normally:
 *
 *     const track = await windowCollection(raw, provider);
 *     const docs = await track.find(selector).toArray();
 *
 * Unrecognised members pass straight through, so index management and writes
 * behave exactly as before. `estimatedDocumentCount` is the one refusal: it
 * accepts no filter, so answering it at all would report the unwindowed total.
 *
 * @param {object} collection - the underlying Mongo collection
 * @param {{clause: function(): Promise<object|null>}} provider
 * @returns {Promise<object>} the façade; a pass-through when there is no clause
 */
export async function windowCollection(collection, provider) {
  const clause = await provider.clause();
  if (!clause) return collection;

  const facade = {
    find(selector, ...rest) {
      return collection.find(withWindow(selector, clause), ...rest);
    },
    findOne(selector, ...rest) {
      return collection.findOne(withWindow(selector, clause), ...rest);
    },
    countDocuments(selector, ...rest) {
      return collection.countDocuments(withWindow(selector, clause), ...rest);
    },
    distinct(field, selector, ...rest) {
      return collection.distinct(field, withWindow(selector, clause), ...rest);
    },
    aggregate(pipeline, ...rest) {
      return collection.aggregate(windowPipeline(pipeline, clause), ...rest);
    },
    estimatedDocumentCount() {
      throw new Error(
        "estimatedDocumentCount takes no filter and cannot be windowed; " +
        "use countDocuments so the public-data window applies"
      );
    },
  };

  // Everything else — createIndex, updateMany, bulkWrite, the driver's own
  // internals — reaches the real collection untouched. Writes are out of the
  // window's scope by design; only reads are constrained.
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (prop === "estimatedDocumentCount" || WINDOWED_METHODS.includes(prop)) {
        return facade[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
