/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * The public-data time window: which time-stamped geo documents may be shown.
 *
 * Two independent suppressions compose here:
 *
 *   1. A rolling delay — nothing newer than `publicDataDelayDays` ago, so a
 *      live animal's current location is never published.
 *   2. Per-individual bounds — `bold:publicDataStart` / `bold:publicDataEnd`
 *      on the individual, so collar-activation tests before deployment and a
 *      dead animal's collar still transmitting from a truck stay hidden.
 *
 * Pure: no Mongo, no Meteor, no clock. `nowMs` is always passed in, which is
 * what makes every case here testable without freezing time.
 *
 * See `.private/specs/crittertrack/time-window-spec.md`.
 */

import { TZDate } from "@date-fns/tz";
import { DisplayApi } from "../api/DisplayApi.js";

/** Properties an individual may carry to bound its own published data. */
export const START_PROPERTY = "bold:publicDataStart";
export const END_PROPERTY   = "bold:publicDataEnd";

/** A bare `YYYY-MM-DD`, which names a calendar day rather than an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Interpret one bound value.
 *
 * Both properties are declared `rdfs:range: "xsd:dateTime"`, but the values
 * actually written are date-only (`"2025-02-01"`), which is not a valid
 * `xsd:dateTime` literal. Rather than reject the data that exists, this accepts
 * a zone-less date, a zone-less dateTime, an offset-bearing instant, epoch
 * milliseconds, or a Date.
 *
 * Zone-less forms are resolved through `DisplayApi.parseZonelessISO`, the same
 * helper the display layer uses, so a bound reads as the same calendar day it
 * was typed as and as the day it renders as. (A `geo/` module reaching into
 * `api/` is unusual here; the alternative was duplicating a DST-aware parser
 * that also rejects impossible dates like `2025-02-30`, which would be strictly
 * worse. `DisplayApi` imports nothing from `geo/`, so there is no cycle.)
 *
 * @param {*} value - the raw property value
 * @param {string} timeZone - IANA zone the wall-clock fields belong to
 * @returns {{ms: number, dateOnly: boolean}|null} null for anything
 *   unparseable — **never** 0 and never NaN. A bound that collapsed to 0 would
 *   suppress an individual's entire history; NaN would poison every comparison
 *   it reached.
 */
export function parseBoundMs(value, timeZone) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? { ms, dateOnly: false } : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? { ms: value, dateOnly: false } : null;
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const zoneless = DisplayApi.parseZonelessISO(trimmed, timeZone);
  if (zoneless.matched) {
    // matched but null means the fields name no real date, e.g. 2025-02-30.
    if (!zoneless.date) return null;
    return { ms: zoneless.date.getTime(), dateOnly: DATE_ONLY.test(trimmed) };
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? { ms: parsed, dateOnly: false } : null;
}

/**
 * Midnight of the day after the one `ms` falls in, in `timeZone`.
 *
 * Built from calendar fields rather than by adding 86,400,000: across a DST
 * boundary a local day is 23 or 25 hours long, and the component constructor
 * rolls day overflow into the next month correctly.
 *
 * @private
 */
function nextMidnightMs(ms, timeZone) {
  const local = new TZDate(ms, timeZone);
  return new TZDate(
    local.getFullYear(), local.getMonth(), local.getDate() + 1, 0, 0, 0, 0, timeZone
  ).getTime();
}

/**
 * Read the bounds off a batch of individual documents.
 *
 * An individual whose bounds are all unparseable is **dropped from the result**
 * rather than emitted with null bounds: an entry with no usable constraint
 * would still pull its id into the `$nin` exclusion list in
 * `buildWindowClause`, which would hide every one of its documents.
 *
 * @param {Array<object>} docs - individual documents carrying either property
 * @param {string} timeZone
 * @returns {Array<{id: string, startMs: number|null, endMs: number|null,
 *   endDateOnly: boolean, endNextDayMs: number|null}>}
 */
export function parseAnimalBounds(docs, timeZone) {
  const out = [];
  for (const doc of docs ?? []) {
    const id = doc?._id;
    if (typeof id !== "string" || id.length === 0) continue;

    const start = parseBoundMs(doc[START_PROPERTY], timeZone);
    const end   = parseBoundMs(doc[END_PROPERTY], timeZone);
    if (!start && !end) {
      // Distinguish "carried nothing" from "carried something we could not
      // read"; the latter is a data problem someone should hear about.
      if (doc[START_PROPERTY] !== undefined || doc[END_PROPERTY] !== undefined) {
        console.warn(
          `timeWindow: ignoring unparseable public-data bounds on ${id} ` +
          `(start=${JSON.stringify(doc[START_PROPERTY])}, end=${JSON.stringify(doc[END_PROPERTY])})`
        );
      }
      continue;
    }

    out.push({
      id,
      startMs: start ? start.ms : null,
      endMs:   end ? end.ms : null,
      endDateOnly:  Boolean(end?.dateOnly),
      endNextDayMs: end?.dateOnly ? nextMidnightMs(end.ms, timeZone) : null,
    });
  }
  return out;
}

/**
 * The newest instant that may be published, quantized to a midnight boundary.
 *
 * Quantizing is deliberate: an unquantized `now - 30d` slides with every
 * request, so two calls a second apart can disagree about whether a document
 * is visible, and nothing downstream is reproducible or cacheable for the day.
 *
 * @param {number} nowMs - current time; always injected, never read from a clock
 * @param {number} delayDays - from `ontologizeOpts.publicDataDelayDays`
 * @param {string} timeZone
 * @returns {number|null} null when no delay applies — a delay of 0 is the
 *   documented way for a deployment to turn the rolling delay off
 */
export function dayCutoffMs(nowMs, delayDays, timeZone) {
  if (typeof delayDays !== "number" || !Number.isFinite(delayDays) || delayDays <= 0) {
    return null;
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;

  const local = new TZDate(nowMs, timeZone);
  return new TZDate(
    local.getFullYear(), local.getMonth(), local.getDate() - delayDays, 0, 0, 0, 0, timeZone
  ).getTime();
}

/**
 * The Mongo clause expressing the window, or null when nothing is constrained.
 *
 * The per-individual half is one `$or`: a `$nin` branch that lets every
 * unbounded individual (and any document naming none at all) through
 * untouched, plus one branch per bounded individual carrying its own limits.
 * At this scale — tens of individuals — the `$or` is small enough to compose
 * per request, which keeps it always current; nothing is denormalized onto the
 * documents, so an admin editing a bound takes effect without a re-stamp.
 *
 * @param {object} opts
 * @param {number|null} opts.cutoffMs - from `dayCutoffMs`
 * @param {Array<object>} opts.bounds - from `parseAnimalBounds`
 * @param {string} [opts.groupProperty="bold:animal"]
 * @param {string} [opts.timeProperty="_whenMs"]
 * @returns {object|null}
 */
export function buildWindowClause({
  cutoffMs, bounds, groupProperty = "bold:animal", timeProperty = "_whenMs",
} = {}) {
  const clauses = [];

  if (typeof cutoffMs === "number" && Number.isFinite(cutoffMs)) {
    clauses.push({ [timeProperty]: { $lte: cutoffMs } });
  }

  const bounded = (bounds ?? []).filter(b => b && (b.startMs !== null || b.endMs !== null));
  if (bounded.length > 0) {
    // The $nin branch also covers documents whose group property is absent:
    // a missing value is $nin any list of ids.
    const branches = [{ [groupProperty]: { $nin: bounded.map(b => b.id) } }];

    for (const bound of bounded) {
      const time = {};
      if (bound.startMs !== null) time.$gte = bound.startMs;
      if (bound.endMs !== null) {
        // A date-only end means the whole of that calendar day stays public, so
        // compare exclusively against the following midnight. A value that
        // named an instant means exactly that instant, inclusive.
        if (bound.endDateOnly && typeof bound.endNextDayMs === "number") {
          time.$lt = bound.endNextDayMs;
        }
        else {
          time.$lte = bound.endMs;
        }
      }
      branches.push({ [groupProperty]: bound.id, [timeProperty]: time });
    }
    clauses.push({ $or: branches });
  }

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/**
 * Compose a caller's selector with the window.
 *
 * **`$and`, never a key merge.** Callers routinely send their own
 * `timeProperty` bound — WILD sends one, `CritterInfo` sends one, the legacy
 * scrubber sends `timeInner` — and spreading keys would let one silently
 * replace the other. In the direction that matters, that *widens* the window
 * and publishes what this module exists to hide.
 *
 * @param {object} [selector={}] - the caller's selector, untouched
 * @param {object|null} clause - from `buildWindowClause`
 * @returns {object}
 */
export function withWindow(selector = {}, clause) {
  if (!clause) return selector ?? {};
  const base = selector ?? {};
  if (Object.keys(base).length === 0) return clause;
  return { $and: [base, clause] };
}
