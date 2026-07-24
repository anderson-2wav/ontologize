/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";
import { MeteorCollectionAdapter } from "../src/adapters/MeteorCollectionAdapter.js";

// Helper function to create mock collections
function createMockCollections() {
  const mockCollection = {
    findOne: () => null,
    find: () => ({
      fetch: () => [],
      toArray: () => Promise.resolve([])
    }),
    count: () => 0
  };
  return {
    ontology: new MeteorCollectionAdapter(mockCollection, "ontology"),
    context: new MeteorCollectionAdapter(mockCollection, "context"),
    statements: new MeteorCollectionAdapter(mockCollection, "statements")
  };
}

describe("Ontologize.formatDate", function() {
  let ontologize;

  beforeEach(function() {
    const mocks = createMockCollections();
    ontologize = new Ontologize(mocks.ontology, mocks.context, mocks.statements);
  });

  describe("default options", function() {
    it("should have default dateFormat", function() {
      assert.equal(ontologize.opts.dateFormat, "M/d/yyyy");
    });

    it("should have default dateTimeFormat", function() {
      assert.equal(ontologize.opts.dateTimeFormat, "M/d/yyyy h:mm a ZZ");
    });

    it("should have default dateTimeZone", function() {
      assert.equal(ontologize.opts.dateTimeZone, "America/Los_Angeles");
    });
  });

  describe("custom options", function() {
    it("should accept custom date options in constructor", function() {
      const mocks = createMockCollections();
      const customOntologize = new Ontologize(mocks.ontology, mocks.context, mocks.statements, {
        dateFormat: "yyyy-MM-dd",
        dateTimeFormat: "yyyy-MM-dd HH:mm",
        dateTimeZone: "UTC"
      });

      assert.equal(customOntologize.opts.dateFormat, "yyyy-MM-dd");
      assert.equal(customOntologize.opts.dateTimeFormat, "yyyy-MM-dd HH:mm");
      assert.equal(customOntologize.opts.dateTimeZone, "UTC");
    });
  });

  describe("formatDate with Date objects", function() {
    it("should format a Date object", function() {
      // Use a fixed date: January 15, 2024
      const date = new Date(2024, 0, 15); // Month is 0-indexed
      const result = ontologize.display.formatDate(date);
      // May be 14 or 15 depending on local vs LA timezone
      assert.match(result, /1\/1[45]\/2024/);
    });

    it("should format a Date object with time", function() {
      // Use a fixed date: January 15, 2024 at 2:30 PM
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.display.formatDate(date, { includeTime: true });
      assert.match(result, /1\/15\/2024/);
    });
  });

  describe("formatDate with ISO strings", function() {
    it("should format an ISO date string", function() {
      // Date-only is anchored in dateTimeZone, so the day is not timezone-dependent.
      assert.equal(ontologize.display.formatDate("2024-01-15"), "1/15/2024");
    });

    it("should format an ISO datetime string", function() {
      // 14:30Z is 6:30 AM in the default America/Los_Angeles, same day.
      assert.equal(ontologize.display.formatDate("2024-01-15T14:30:00Z"), "1/15/2024");
    });
  });

  // A zone-less ISO string carries no instant of its own — only wall-clock fields.
  // ECMA-262 would resolve those against UTC (date-only) or the machine's zone
  // (date-time), either of which can land on a different calendar day once the value
  // is rendered in dateTimeZone. Ontologize resolves them against dateTimeZone
  // instead, so the day you wrote is the day that displays.
  describe("formatDate with zone-less ISO strings", function() {
    it("should render a date-only string as that calendar date", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10"), "8/10/2026");
    });

    it("should treat a date-only string as midnight in dateTimeZone", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10", { includeTime: true }), "8/10/2026 12:00 AM PDT");
    });

    it("should treat an offset-less datetime as wall clock in dateTimeZone", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10T14:30:00", { includeTime: true }), "8/10/2026 2:30 PM PDT");
    });

    it("should accept a space separator and fractional seconds", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10 14:30:00.123", { includeTime: true }), "8/10/2026 2:30 PM PDT");
    });

    it("should accept an hour:minute datetime with no seconds", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10T14:30", { includeTime: true }), "8/10/2026 2:30 PM PDT");
    });

    it("should resolve against a custom dateTimeZone", function() {
      const mocks = createMockCollections();
      const tokyo = new Ontologize(mocks.ontology, mocks.context, mocks.statements, {
        dateTimeZone: "Asia/Tokyo"
      });
      // East of UTC, where the UTC-midnight reading would have landed on the same
      // day — this pins that the date is anchored in the zone, not merely shifted.
      assert.equal(tokyo.display.formatDate("2026-08-10"), "8/10/2026");
      assert.equal(tokyo.display.formatDate("2026-08-10", { includeTime: true }), "8/10/2026 12:00 AM GMT+9");
    });

    it("should honor a dateTimeZone passed per call", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10", { includeTime: true, dateTimeZone: "UTC" }),
        "8/10/2026 12:00 AM UTC");
    });

    it("should leave a Z-suffixed instant converted into dateTimeZone", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10T12:00:00Z", { includeTime: true }), "8/10/2026 5:00 AM PDT");
    });

    it("should leave an offset-bearing instant converted into dateTimeZone", function() {
      // 23:30 +02:00 is 14:30 PDT the same day.
      assert.equal(ontologize.display.formatDate("2026-08-10T23:30:00+02:00", { includeTime: true }), "8/10/2026 2:30 PM PDT");
    });

    it("should render a JSON-LD xsd:date literal as that calendar date", function() {
      assert.equal(ontologize.display.formatDate({ "@value": "2026-08-10", "@type": "xsd:date" }), "8/10/2026");
    });

    it("should reject an out-of-range day rather than rolling it over", function() {
      // Constructing from components would silently roll Feb 30 into March.
      assert.equal(ontologize.display.formatDate("2026-02-30"), "");
    });

    it("should reject an out-of-range month", function() {
      assert.equal(ontologize.display.formatDate("2026-13-01"), "");
    });

    it("should reject an out-of-range hour", function() {
      assert.equal(ontologize.display.formatDate("2026-08-10T25:00:00"), "");
    });

    it("should accept a real leap day", function() {
      assert.equal(ontologize.display.formatDate("2028-02-29"), "2/29/2028");
    });
  });

  describe("formatDate with timestamps", function() {
    it("should format a timestamp (number)", function() {
      const timestamp = new Date(2024, 0, 15).getTime();
      const result = ontologize.display.formatDate(timestamp);
      // May be 14 or 15 depending on local vs LA timezone
      assert.match(result, /1\/1[45]\/2024/);
    });
  });

  describe("formatDate with JSON-LD typed literals", function() {
    it("should format a JSON-LD @value wrapper", function() {
      const jsonLdDate = {
        "@value": "2024-01-15",
        "@type": "xsd:date"
      };
      assert.equal(ontologize.display.formatDate(jsonLdDate), "1/15/2024");
    });

    it("should format a JSON-LD datetime @value", function() {
      const jsonLdDateTime = {
        "@value": "2024-01-15T14:30:00Z",
        "@type": "xsd:dateTime"
      };
      assert.equal(ontologize.display.formatDate(jsonLdDateTime), "1/15/2024");
    });
  });

  describe("formatDate with invalid inputs", function() {
    it("should return empty string for null", function() {
      const result = ontologize.display.formatDate(null);
      assert.equal(result, "");
    });

    it("should return empty string for undefined", function() {
      const result = ontologize.display.formatDate(undefined);
      assert.equal(result, "");
    });

    it("should return empty string for invalid date string", function() {
      const result = ontologize.display.formatDate("not-a-date");
      assert.equal(result, "");
    });

    it("should return empty string for empty object", function() {
      const result = ontologize.display.formatDate({});
      assert.equal(result, "");
    });
  });

  describe("formatDate with format overrides", function() {
    it("should use custom dateFormat from opts", function() {
      const date = new Date(2024, 0, 15);
      const result = ontologize.display.formatDate(date, { dateFormat: "yyyy-MM-dd" });
      // May be 14 or 15 depending on local vs LA timezone
      assert.match(result, /2024-01-1[45]/);
    });

    it("should use custom dateTimeFormat from opts", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.display.formatDate(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm",
        includeTime: true
      });
      assert.match(result, /2024-01-15/);
    });

    it("should use custom dateTimeFormat with ZZ from opts", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.display.formatDate(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm ZZ",
        includeTime: true
      });
      assert.match(result, /2024-01-15/);
    });
  });

  describe("formatDateTime shorthand", function() {
    it("should format date with time using default format", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.display.formatDateTime(date);
      // Default dateTimeFormat is "M/d/yyyy h:mm a"
      assert.match(result, /1\/1[45]\/2024/);
      assert.match(result, /[0-9]+:[0-9]+ [AP]M/i);
    });

    it("should accept custom dateTimeFormat", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.display.formatDateTime(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm"
      });
      assert.match(result, /2024-01-1[45] [0-9]{2}:[0-9]{2}/);
    });

    it("should handle ZZ timezone format", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.display.formatDateTime(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm ZZ"
      });
      assert.match(result, /2024-01-1[45] [0-9]{2}:[0-9]{2} [A-Z]{3,4}/);
    });

    it("should return empty string for invalid input", function() {
      assert.equal(ontologize.display.formatDateTime(null), "");
      assert.equal(ontologize.display.formatDateTime(undefined), "");
    });
  });
});
