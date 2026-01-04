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
    ontology: new MeteorCollectionAdapter(mockCollection, "Ontology"),
    context: new MeteorCollectionAdapter(mockCollection, "Context"),
    statements: new MeteorCollectionAdapter(mockCollection, "Statements")
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
      assert.equal(ontologize.opts.dateTimeFormat, "M/d/yyyy h:mm a");
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
      const result = ontologize.formatDate(date);
      // May be 14 or 15 depending on local vs LA timezone
      assert.match(result, /1\/1[45]\/2024/);
    });

    it("should format a Date object with time", function() {
      // Use a fixed date: January 15, 2024 at 2:30 PM
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.formatDate(date, { includeTime: true });
      assert.match(result, /1\/15\/2024/);
    });
  });

  describe("formatDate with ISO strings", function() {
    it("should format an ISO date string", function() {
      const result = ontologize.formatDate("2024-01-15");
      assert.match(result, /1\/1[45]\/2024/); // May be 14 or 15 depending on timezone
    });

    it("should format an ISO datetime string", function() {
      const result = ontologize.formatDate("2024-01-15T14:30:00Z");
      assert.match(result, /1\/1[45]\/2024/);
    });
  });

  describe("formatDate with timestamps", function() {
    it("should format a timestamp (number)", function() {
      const timestamp = new Date(2024, 0, 15).getTime();
      const result = ontologize.formatDate(timestamp);
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
      const result = ontologize.formatDate(jsonLdDate);
      assert.match(result, /1\/1[45]\/2024/);
    });

    it("should format a JSON-LD datetime @value", function() {
      const jsonLdDateTime = {
        "@value": "2024-01-15T14:30:00Z",
        "@type": "xsd:dateTime"
      };
      const result = ontologize.formatDate(jsonLdDateTime);
      assert.match(result, /1\/1[45]\/2024/);
    });
  });

  describe("formatDate with invalid inputs", function() {
    it("should return empty string for null", function() {
      const result = ontologize.formatDate(null);
      assert.equal(result, "");
    });

    it("should return empty string for undefined", function() {
      const result = ontologize.formatDate(undefined);
      assert.equal(result, "");
    });

    it("should return empty string for invalid date string", function() {
      const result = ontologize.formatDate("not-a-date");
      assert.equal(result, "");
    });

    it("should return empty string for empty object", function() {
      const result = ontologize.formatDate({});
      assert.equal(result, "");
    });
  });

  describe("formatDate with format overrides", function() {
    it("should use custom dateFormat from opts", function() {
      const date = new Date(2024, 0, 15);
      const result = ontologize.formatDate(date, { dateFormat: "yyyy-MM-dd" });
      // May be 14 or 15 depending on local vs LA timezone
      assert.match(result, /2024-01-1[45]/);
    });

    it("should use custom dateTimeFormat from opts", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.formatDate(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm",
        includeTime: true
      });
      assert.match(result, /2024-01-15/);
    });

    it("should use custom dateTimeFormat with ZZ from opts", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.formatDate(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm ZZ",
        includeTime: true
      });
      assert.match(result, /2024-01-15/);
    });
  });

  describe("formatDateTime shorthand", function() {
    it("should format date with time using default format", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.formatDateTime(date);
      // Default dateTimeFormat is "M/d/yyyy h:mm a"
      assert.match(result, /1\/1[45]\/2024/);
      assert.match(result, /[0-9]+:[0-9]+ [AP]M/i);
    });

    it("should accept custom dateTimeFormat", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.formatDateTime(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm"
      });
      assert.match(result, /2024-01-1[45] [0-9]{2}:[0-9]{2}/);
    });

    it("should handle ZZ timezone format", function() {
      const date = new Date(2024, 0, 15, 14, 30);
      const result = ontologize.formatDateTime(date, {
        dateTimeFormat: "yyyy-MM-dd HH:mm ZZ"
      });
      assert.match(result, /2024-01-1[45] [0-9]{2}:[0-9]{2} [A-Z]{3,4}/);
    });

    it("should return empty string for invalid input", function() {
      assert.equal(ontologize.formatDateTime(null), "");
      assert.equal(ontologize.formatDateTime(undefined), "");
    });
  });
});
