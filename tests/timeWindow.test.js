/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Tests for the public-data time window: the pure clause builders behind the
 * rolling delay and the per-animal bold:publicDataStart/End bounds.
 *
 * See `.private/specs/crittertrack/time-window-spec.md`.
 */

import { assert } from "chai";
import {
  parseBoundMs, parseAnimalBounds, dayCutoffMs, buildWindowClause, withWindow,
} from "../src/geo/timeWindow.js";

const ZONE = "America/Chicago";

// Chicago is UTC-6 in winter (CST) and UTC-5 in summer (CDT). Expected values
// are written as explicit UTC instants rather than derived with the same date
// library the implementation uses, so a bug in that usage cannot cancel out.
const FEB1_MIDNIGHT = Date.parse("2025-02-01T06:00:00Z");
const JUN1_MIDNIGHT = Date.parse("2025-06-01T05:00:00Z");

describe("parseBoundMs", function() {
  it("resolves a date-only value to midnight in the configured zone", function() {
    // The worked example from the spec: track:animal-MA04's publicDataStart.
    const out = parseBoundMs("2025-02-01", ZONE);
    assert.equal(out.ms, FEB1_MIDNIGHT);
    assert.isTrue(out.dateOnly, "a bare date is a calendar day, not an instant");
  });

  it("resolves a zone-less dateTime as wall-clock in the configured zone", function() {
    const out = parseBoundMs("2025-02-01T12:00:00", ZONE);
    assert.equal(out.ms, Date.parse("2025-02-01T18:00:00Z"));
    assert.isFalse(out.dateOnly);
  });

  // The declared rdfs:range is xsd:dateTime, but the values actually written
  // are date-only. Both forms have to work.
  it("accepts an offset-bearing instant unchanged", function() {
    const out = parseBoundMs("2025-02-01T06:00:00Z", ZONE);
    assert.equal(out.ms, FEB1_MIDNIGHT);
    assert.isFalse(out.dateOnly);
  });

  it("accepts epoch milliseconds", function() {
    const out = parseBoundMs(FEB1_MIDNIGHT, ZONE);
    assert.equal(out.ms, FEB1_MIDNIGHT);
    assert.isFalse(out.dateOnly);
  });

  // The whole point of the guard: a bound that silently became 0 would suppress
  // an animal's entire history, and a bound that became NaN would poison every
  // comparison it touched.
  it("is null for values it cannot parse, never zero", function() {
    for (const bad of ["", "   ", "not a date", "2025-13-01", "2025-02-30", null, undefined, NaN, {}, []]) {
      assert.isNull(parseBoundMs(bad, ZONE), `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it("honours daylight saving when resolving midnight", function() {
    // 2025-03-09 is the US spring-forward day; Chicago is still CST at midnight.
    assert.equal(parseBoundMs("2025-03-09", ZONE).ms, Date.parse("2025-03-09T06:00:00Z"));
    // ...and CDT by the next midnight, so that day is only 23 hours long.
    assert.equal(parseBoundMs("2025-03-10", ZONE).ms, Date.parse("2025-03-10T05:00:00Z"));
  });
});

describe("parseAnimalBounds", function() {
  const docs = [
    { _id: "track:animal-MA04", "bold:publicDataStart": "2025-02-01" },
    { _id: "track:animal-MA05", "bold:publicDataEnd": "2025-06-01" },
    { _id: "track:animal-MA06", "bold:publicDataStart": "2025-02-01", "bold:publicDataEnd": "2025-06-01" },
  ];

  it("reads both properties off an animal document", function() {
    const bounds = parseAnimalBounds(docs, ZONE);
    const byId = Object.fromEntries(bounds.map(b => [b.id, b]));

    assert.equal(byId["track:animal-MA04"].startMs, FEB1_MIDNIGHT);
    assert.isNull(byId["track:animal-MA04"].endMs);
    assert.isNull(byId["track:animal-MA05"].startMs);
    assert.equal(byId["track:animal-MA05"].endMs, JUN1_MIDNIGHT);
    assert.equal(byId["track:animal-MA06"].startMs, FEB1_MIDNIGHT);
  });

  it("marks a date-only end so the builder can extend it to end-of-day", function() {
    const [bound] = parseAnimalBounds([docs[1]], ZONE);
    assert.isTrue(bound.endDateOnly);
  });

  it("drops an animal whose bounds are all unparseable rather than bounding it to nothing", function() {
    const bounds = parseAnimalBounds([{ _id: "a:1", "bold:publicDataStart": "garbage" }], ZONE);
    assert.lengthOf(bounds, 0);
  });

  it("keeps the parseable half when only one bound is broken", function() {
    const bounds = parseAnimalBounds(
      [{ _id: "a:1", "bold:publicDataStart": "2025-02-01", "bold:publicDataEnd": "garbage" }], ZONE
    );
    assert.equal(bounds[0].startMs, FEB1_MIDNIGHT);
    assert.isNull(bounds[0].endMs);
  });

  it("ignores documents with no bounds at all", function() {
    assert.lengthOf(parseAnimalBounds([{ _id: "a:1" }], ZONE), 0);
    assert.lengthOf(parseAnimalBounds([], ZONE), 0);
    assert.lengthOf(parseAnimalBounds(null, ZONE), 0);
  });
});

describe("dayCutoffMs", function() {
  const noonJun10 = Date.parse("2025-06-10T17:00:00Z");   // 12:00 Chicago

  it("is midnight of the day `delayDays` before now", function() {
    assert.equal(dayCutoffMs(noonJun10, 30, ZONE), Date.parse("2025-05-11T05:00:00Z"));
  });

  // Quantizing is what keeps a day's results reproducible instead of sliding
  // with every request.
  it("is identical for two different times on the same day", function() {
    const earlyJun10 = Date.parse("2025-06-10T13:00:00Z");  // 08:00 Chicago
    const lateJun10  = Date.parse("2025-06-11T04:00:00Z");  // 23:00 Chicago
    assert.equal(dayCutoffMs(earlyJun10, 30, ZONE), dayCutoffMs(lateJun10, 30, ZONE));
  });

  it("advances by exactly one day when now advances one day", function() {
    const noonJun11 = Date.parse("2025-06-11T17:00:00Z");
    const a = dayCutoffMs(noonJun10, 30, ZONE);
    const b = dayCutoffMs(noonJun11, 30, ZONE);
    assert.equal(b - a, 86400000);
  });

  // The escape hatch: a deployment that wants no delay configures 0.
  it("is null when the delay is zero or negative", function() {
    assert.isNull(dayCutoffMs(noonJun10, 0, ZONE));
    assert.isNull(dayCutoffMs(noonJun10, -1, ZONE));
  });

  it("is null rather than NaN for a non-numeric delay", function() {
    assert.isNull(dayCutoffMs(noonJun10, undefined, ZONE));
    assert.isNull(dayCutoffMs(noonJun10, "30", ZONE));
  });
});

describe("buildWindowClause", function() {
  const BOUNDS = [
    { id: "track:animal-MA04", startMs: FEB1_MIDNIGHT, endMs: null, endDateOnly: false },
  ];

  it("is null when nothing constrains anything", function() {
    assert.isNull(buildWindowClause({ cutoffMs: null, bounds: [] }));
  });

  it("is the bare delay clause when no animal has bounds", function() {
    const clause = buildWindowClause({ cutoffMs: 1000, bounds: [] });
    assert.deepEqual(clause, { _whenMs: { $lte: 1000 } });
  });

  it("lets an animal with no bounds through the $or unconstrained", function() {
    const clause = buildWindowClause({ cutoffMs: null, bounds: BOUNDS });
    assert.deepEqual(clause.$or[0], { "bold:animal": { $nin: ["track:animal-MA04"] } });
  });

  it("constrains a bounded animal by its own start", function() {
    const clause = buildWindowClause({ cutoffMs: null, bounds: BOUNDS });
    assert.deepEqual(clause.$or[1], {
      "bold:animal": "track:animal-MA04",
      _whenMs: { $gte: FEB1_MIDNIGHT },
    });
  });

  // A date-only end means the whole of that calendar day is still public, so
  // the comparison is exclusive against the following midnight — which is 23 or
  // 25 hours later across a DST boundary, not always 24.
  it("extends a date-only end to the following midnight, exclusively", function() {
    const clause = buildWindowClause({
      cutoffMs: null,
      bounds: [{ id: "a:1", startMs: null, endMs: Date.parse("2025-03-09T06:00:00Z"),
                 endDateOnly: true, endNextDayMs: Date.parse("2025-03-10T05:00:00Z") }],
    });
    assert.deepEqual(clause.$or[1]._whenMs, { $lt: Date.parse("2025-03-10T05:00:00Z") });
  });

  it("uses an inclusive end for a value that named an instant", function() {
    const clause = buildWindowClause({
      cutoffMs: null,
      bounds: [{ id: "a:1", startMs: null, endMs: 9000, endDateOnly: false }],
    });
    assert.deepEqual(clause.$or[1]._whenMs, { $lte: 9000 });
  });

  it("ands the delay with the per-animal $or when both apply", function() {
    const clause = buildWindowClause({ cutoffMs: 1000, bounds: BOUNDS });
    assert.lengthOf(clause.$and, 2);
    assert.deepEqual(clause.$and[0], { _whenMs: { $lte: 1000 } });
    assert.property(clause.$and[1], "$or");
  });

  it("honours non-default group and time properties", function() {
    const clause = buildWindowClause({
      cutoffMs: 1000, bounds: [{ id: "a:1", startMs: 5, endMs: null, endDateOnly: false }],
      groupProperty: "bold:subject", timeProperty: "_observedMs",
    });
    assert.deepEqual(clause.$and[0], { _observedMs: { $lte: 1000 } });
    assert.deepEqual(clause.$and[1].$or[1], { "bold:subject": "a:1", _observedMs: { $gte: 5 } });
  });
});

describe("withWindow", function() {
  const CLAUSE = { _whenMs: { $lte: 1000 } };

  it("returns the selector untouched when there is no clause", function() {
    const selector = { "@type": "track:CollarReport" };
    assert.deepEqual(withWindow(selector, null), selector);
  });

  it("returns the bare clause for an empty selector rather than anding with {}", function() {
    assert.deepEqual(withWindow({}, CLAUSE), CLAUSE);
    assert.deepEqual(withWindow(undefined, CLAUSE), CLAUSE);
  });

  // THE test. WILD, CritterInfo and the legacy scrubber all send their own
  // _whenMs; merging by spreading keys would let one silently replace the
  // other, and in the wrong direction that WIDENS the window.
  it("preserves a caller's own time bound instead of overwriting it", function() {
    const callerBound = Date.parse("2025-03-01T00:00:00Z");
    const out = withWindow({ _whenMs: { $gte: callerBound } }, CLAUSE);

    assert.deepEqual(out, { $and: [{ _whenMs: { $gte: callerBound } }, CLAUSE] });
    assert.notProperty(out, "_whenMs", "the two bounds must not be collapsed into one key");
  });

  it("keeps every other selector key intact", function() {
    const out = withWindow({ "@type": "track:CollarReport", _h3_7: "871f8d4ffffffff" }, CLAUSE);
    assert.deepEqual(out.$and[0], { "@type": "track:CollarReport", _h3_7: "871f8d4ffffffff" });
  });

  it("nests rather than merging when the selector already has its own $and", function() {
    const selector = { $and: [{ a: 1 }, { b: 2 }] };
    const out = withWindow(selector, CLAUSE);
    assert.deepEqual(out, { $and: [selector, CLAUSE] });
  });
});
