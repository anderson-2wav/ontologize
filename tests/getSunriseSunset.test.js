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

describe("Ontologize.getSunriseSunset", function() {
  let ontologize;

  beforeEach(function() {
    const mocks = createMockCollections();
    ontologize = new Ontologize(mocks.ontology, mocks.context, mocks.statements);
  });

  describe("parameter validation", function() {
    it("should throw error for non-array longLat", async function() {
      try {
        await ontologize.getSunriseSunset("not-an-array", new Date());
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.include(error.message, "longLat must be an array");
      }
    });

    it("should throw error for array with wrong length", async function() {
      try {
        await ontologize.getSunriseSunset([1], new Date());
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.include(error.message, "longLat must be an array");
      }
    });

    it("should throw error for non-numeric coordinates", async function() {
      try {
        await ontologize.getSunriseSunset(["a", "b"], new Date());
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.include(error.message, "longitude and latitude must be numbers");
      }
    });

    it("should throw error for invalid date", async function() {
      try {
        await ontologize.getSunriseSunset([-122.4194, 37.7749], "not-a-date");
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.include(error.message, "Invalid date");
      }
    });

    it("should throw error for null date", async function() {
      try {
        await ontologize.getSunriseSunset([-122.4194, 37.7749], null);
        assert.fail("Should have thrown an error");
      }
      catch (error) {
        assert.ok(error);
      }
    });
  });

  describe("date handling", function() {
    // These tests verify date parsing without making API calls
    // The actual API call tests are in the "API integration" section

    it("should accept Date object", async function() {
      // This will attempt API call, but we're testing that it doesn't throw on date parsing
      const date = new Date(2024, 5, 15); // June 15, 2024
      try {
        // This may fail due to network, but shouldn't fail on date parsing
        await ontologize.getSunriseSunset([-122.4194, 37.7749], date);
      }
      catch (error) {
        // If error is about date, fail the test
        if (error.message.includes("Invalid date")) {
          assert.fail("Should accept Date object");
        }
        // Otherwise it's likely a network error, which is fine for this test
      }
    });

    it("should accept ISO date string", async function() {
      try {
        await ontologize.getSunriseSunset([-122.4194, 37.7749], "2024-06-15");
      }
      catch (error) {
        if (error.message.includes("Invalid date")) {
          assert.fail("Should accept ISO date string");
        }
      }
    });

    it("should accept timestamp number", async function() {
      const timestamp = new Date(2024, 5, 15).getTime();
      try {
        await ontologize.getSunriseSunset([-122.4194, 37.7749], timestamp);
      }
      catch (error) {
        if (error.message.includes("Invalid date")) {
          assert.fail("Should accept timestamp number");
        }
      }
    });

    it("should accept JSON-LD @value wrapper", async function() {
      const jsonLdDate = {
        "@value": "2024-06-15",
        "@type": "xsd:date"
      };
      try {
        await ontologize.getSunriseSunset([-122.4194, 37.7749], jsonLdDate);
      }
      catch (error) {
        if (error.message.includes("Invalid date")) {
          assert.fail("Should accept JSON-LD @value wrapper");
        }
      }
    });
  });

  describe("API integration", function() {
    // These tests make actual API calls - they may be slow or fail due to network issues
    // Consider skipping in CI environments

    it("should return sunrise/sunset data for San Francisco", async function() {
      this.timeout(10000); // Allow 10 seconds for API call

      try {
        const result = await ontologize.getSunriseSunset(
          [-122.4194, 37.7749], // San Francisco [long, lat]
          new Date(2024, 5, 15) // June 15, 2024
        );

        // Verify response structure
        assert.ok(result.sunrise, "Should have sunrise");
        assert.ok(result.sunset, "Should have sunset");
        assert.ok(result.solarNoon, "Should have solarNoon");
        assert.ok(result.dayLength, "Should have dayLength");
        assert.ok(result.civilTwilightBegin, "Should have civilTwilightBegin");
        assert.ok(result.civilTwilightEnd, "Should have civilTwilightEnd");

        // Verify sunrise is before sunset
        const sunrise = new Date(result.sunrise);
        const sunset = new Date(result.sunset);
        assert.ok(sunrise < sunset, "Sunrise should be before sunset");
      }
      catch (error) {
        // Skip test if network error
        if (error.message.includes("fetch") || error.message.includes("network") || error.code === "ENOTFOUND") {
          this.skip();
        }
        throw error;
      }
    });

    it("should return different times for different locations", async function() {
      this.timeout(15000); // Allow 15 seconds for two API calls

      try {
        const sfResult = await ontologize.getSunriseSunset(
          [-122.4194, 37.7749], // San Francisco
          new Date(2024, 5, 15)
        );

        const nyResult = await ontologize.getSunriseSunset(
          [-74.006, 40.7128], // New York
          new Date(2024, 5, 15)
        );

        // Sunrise in NY should be earlier than SF (NY is east)
        const sfSunrise = new Date(sfResult.sunrise);
        const nySunrise = new Date(nyResult.sunrise);
        assert.ok(nySunrise < sfSunrise, "NY sunrise should be before SF sunrise");
      }
      catch (error) {
        if (error.message.includes("fetch") || error.message.includes("network") || error.code === "ENOTFOUND") {
          this.skip();
        }
        throw error;
      }
    });
  });
});
