/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { getSpatialRange, positionsOf, HULL_TYPES, DEFAULT_ALPHA } from "../src/geo/range.js";

/** A MultiPoint carrying the given [lng, lat] positions. */
const points = (coords) => ({ type: "MultiPoint", coordinates: coords });

/** The four corners of a degree square, plus a point in the middle. */
const CORNERS = [[-88, 40], [-87, 40], [-87, 41], [-88, 41]];
const SQUARE_PLUS_CENTRE = points([...CORNERS, [-87.5, 40.5]]);

/** Planar shoelace — positive is counterclockwise in a lng/lat frame. */
function shoelace(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/** The Feature's outer ring, with the duplicated closing position removed. */
const openRing = (feature) => feature.geometry.coordinates[0].slice(0, -1);
const diag = (feature) => feature.properties["bold:rangeDiagnostics"];

/** A ragged but well-separated cloud: two clusters with a thin neck between. */
function dumbbell() {
  const coords = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    coords.push([-88 + 0.1 * Math.cos(a), 40 + 0.1 * Math.sin(a)]);
    coords.push([-87 + 0.1 * Math.cos(a), 40 + 0.1 * Math.sin(a)]);
  }
  return points(coords);
}

describe("getSpatialRange", function() {

  describe("positionsOf", function() {
    it("reads a bare Point", function() {
      assert.deepEqual(positionsOf({ type: "Point", coordinates: [1, 2] }), [[1, 2]]);
    });

    it("reads every position of a MultiPolygon", function() {
      const geo = {
        type: "MultiPolygon",
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[5, 5], [6, 5], [6, 6], [5, 5]]]
        ]
      };
      assert.lengthOf(positionsOf(geo), 8);
    });

    it("descends Features, FeatureCollections and GeometryCollections alike", function() {
      const geo = {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } },
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "GeometryCollection",
              geometries: [
                { type: "LineString", coordinates: [[3, 4], [5, 6]] },
                { type: "Point", coordinates: [7, 8] }
              ]
            }
          }
        ]
      };
      assert.deepEqual(positionsOf(geo), [[1, 2], [3, 4], [5, 6], [7, 8]]);
    });

    it("returns nothing for null, undefined, and coordinate-less objects", function() {
      assert.deepEqual(positionsOf(null), []);
      assert.deepEqual(positionsOf(undefined), []);
      assert.deepEqual(positionsOf({ type: "Point" }), []);
    });

    it("skips non-finite positions rather than emitting NaN", function() {
      const geo = { type: "MultiPoint", coordinates: [[1, 2], [NaN, 3], [4, null]] };
      assert.deepEqual(positionsOf(geo), [[1, 2]]);
    });
  });

  describe("hull", function() {
    it("encloses a point cloud, dropping interior points", function() {
      const f = getSpatialRange([SQUARE_PLUS_CENTRE]);
      assert.equal(f.type, "Feature");
      assert.equal(f.geometry.type, "Polygon");
      // 4 corners + the repeated closing position; the centre is inside.
      assert.lengthOf(f.geometry.coordinates[0], 5);
    });

    it("closes the ring", function() {
      const ring = getSpatialRange([SQUARE_PLUS_CENTRE]).geometry.coordinates[0];
      assert.deepEqual(ring[0], ring[ring.length - 1]);
    });

    it("returns null below three distinct positions", function() {
      assert.isNull(getSpatialRange([points([[0, 0], [1, 1]])]));
      assert.isNull(getSpatialRange([]));
      assert.isNull(getSpatialRange(null));
    });

    it("treats repeated positions as one — a stationary collar is not a hull", function() {
      const stationary = points([[0, 0], [0, 0], [0, 0], [0, 0]]);
      assert.isNull(getSpatialRange([stationary]));
    });

    it("mixes points, lines and polygons in one range", function() {
      const f = getSpatialRange([
        { type: "Point", coordinates: [-88, 40] },
        { type: "LineString", coordinates: [[-87, 40], [-87, 41]] },
        { type: "Polygon", coordinates: [[[-88, 41], [-87.5, 41], [-87.5, 41], [-88, 41]]] }
      ]);
      assert.isNotNull(f);
      assert.equal(diag(f).inputs, 3);
      assert.isAtLeast(diag(f).positions, 7);
    });

    it("accepts a single shape not wrapped in an array", function() {
      assert.isNotNull(getSpatialRange(SQUARE_PLUS_CENTRE));
    });
  });

  describe("hullType", function() {
    it("a concave hull of a dumbbell encloses less than its convex hull", function() {
      const cloud = dumbbell();
      const convex = getSpatialRange([cloud], { hullType: "convex" });
      const concave = getSpatialRange([cloud], { hullType: "concave", alpha: 1 });
      assert.isBelow(diag(concave).areaKm2, diag(convex).areaKm2);
    });

    it("alpha 0 makes the concave hull the convex one", function() {
      const cloud = dumbbell();
      const convex = getSpatialRange([cloud], { hullType: "convex" });
      const concave = getSpatialRange([cloud], { hullType: "concave", alpha: 0 });
      assert.closeTo(diag(concave).areaKm2, diag(convex).areaKm2, 0.01);
    });

    it("falls back to convex when there are too few points to triangulate", function() {
      const f = getSpatialRange([points(CORNERS)], { hullType: "concave" });
      assert.isNotNull(f);
      assert.lengthOf(f.geometry.coordinates[0], 5);
    });

    it("rejects an unknown hullType rather than silently picking one", function() {
      assert.throws(() => getSpatialRange([SQUARE_PLUS_CENTRE], { hullType: "alpha" }), /unknown hullType/);
    });

    it("exposes the hull types and default alpha it honours", function() {
      assert.deepEqual(HULL_TYPES, ["convex", "concave"]);
      assert.equal(DEFAULT_ALPHA, 0.5);
    });
  });

  describe("winding", function() {
    it("defaults to cw — the d3-geo and 2dsphere convention BOLD draws with", function() {
      const f = getSpatialRange([SQUARE_PLUS_CENTRE]);
      assert.isBelow(shoelace(openRing(f)), 0);
      assert.equal(diag(f).winding, "cw");
    });

    it("emits ccw on request, for RFC 7946", function() {
      const f = getSpatialRange([SQUARE_PLUS_CENTRE], { winding: "ccw" });
      assert.isAbove(shoelace(openRing(f)), 0);
      assert.equal(diag(f).winding, "ccw");
    });

    it("encloses the same area either way", function() {
      const cw = getSpatialRange([SQUARE_PLUS_CENTRE], { winding: "cw" });
      const ccw = getSpatialRange([SQUARE_PLUS_CENTRE], { winding: "ccw" });
      assert.equal(diag(cw).areaKm2, diag(ccw).areaKm2);
    });

    it("rejects an unknown winding — including mergeShapes' 'match'", function() {
      assert.throws(() => getSpatialRange([SQUARE_PLUS_CENTRE], { winding: "match" }), /unknown winding/);
    });
  });

  describe("projection", function() {
    /**
     * A degree of longitude is ~78% of a degree of latitude at 38.9°N. Hulling
     * raw degrees would stretch the cloud east-west; the local planar frame is
     * what keeps a round cloud round.
     */
    it("keeps a geographically circular cloud circular, not stretched", function() {
      const lat0 = 38.9, km = 1 / 111;
      const coords = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        coords.push([
          -104.9 + (10 * km * Math.cos(a)) / Math.cos((lat0 * Math.PI) / 180),
          lat0 + 10 * km * Math.sin(a)
        ]);
      }
      const f = getSpatialRange([points(coords)]);
      // A 10 km radius circle is ~314 km²; a stretched hull would overshoot.
      assert.closeTo(diag(f).areaKm2, 314, 15);
    });
  });

  describe("properties and diagnostics", function() {
    it("carries the caller's properties onto the Feature", function() {
      const f = getSpatialRange([SQUARE_PLUS_CENTRE], {
        properties: { "rdfs:label": "MA04", color: "orange" }
      });
      assert.equal(f.properties["rdfs:label"], "MA04");
      assert.equal(f.properties.color, "orange");
    });

    it("reports inputs, positions and what the hull actually saw", function() {
      const d = diag(getSpatialRange([points([...CORNERS, [-88, 40], [-87.5, 40.5]])]));
      assert.equal(d.inputs, 1);
      assert.equal(d.positions, 6);      // one corner repeated
      assert.equal(d.distinctPositions, 5);
      assert.equal(d.hullType, "convex");
      assert.isNull(d.alpha);            // meaningless for a convex hull
    });

    it("records alpha for a concave hull", function() {
      const d = diag(getSpatialRange([dumbbell()], { hullType: "concave", alpha: 0.75 }));
      assert.equal(d.hullType, "concave");
      assert.equal(d.alpha, 0.75);
    });

    it("omits diagnostics on request", function() {
      const f = getSpatialRange([SQUARE_PLUS_CENTRE], { diagnostics: false });
      assert.isUndefined(f.properties["bold:rangeDiagnostics"]);
    });

    it("counts vertices including the closing position", function() {
      const f = getSpatialRange([SQUARE_PLUS_CENTRE]);
      assert.equal(diag(f).vertices, f.geometry.coordinates[0].length);
    });
  });

  describe("does not mutate its input", function() {
    it("leaves the caller's geometry untouched", function() {
      const shape = points([...CORNERS, [-87.5, 40.5]]);
      const before = JSON.stringify(shape);
      getSpatialRange([shape], { hullType: "concave" });
      assert.equal(JSON.stringify(shape), before);
    });

    it("does not share the properties object the caller passed", function() {
      const properties = { "rdfs:label": "MA04" };
      getSpatialRange([SQUARE_PLUS_CENTRE], { properties });
      assert.deepEqual(properties, { "rdfs:label": "MA04" });
    });
  });
});
