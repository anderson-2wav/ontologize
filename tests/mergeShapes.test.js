/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { mergeShapes, geoArea } from "../src/geo/merge.js";

/** Axis-aligned square as a bare Polygon geometry. */
function square(x, y, size = 1) {
  return {
    type: "Polygon",
    coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
  };
}

/** Square with a square hole punched in the middle. */
function squareWithHole(x, y, size, holeSize) {
  const off = (size - holeSize) / 2;
  const hx = x + off, hy = y + off;
  return {
    type: "Polygon",
    coordinates: [
      [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]],
      // interior ring, wound the other way
      [[hx, hy], [hx, hy + holeSize], [hx + holeSize, hy + holeSize], [hx + holeSize, hy], [hx, hy]]
    ]
  };
}

const feature = (geometry, properties = {}) => ({ type: "Feature", geometry, properties });
const diag = (f) => f.properties["bold:mergeDiagnostics"];

/** Same polygon, every ring reversed — flips it between the two conventions. */
function reverseRings(polygon) {
  return { ...polygon, coordinates: polygon.coordinates.map((ring) => [...ring].reverse()) };
}

/**
 * Winding of a ring by the shoelace sign, computed independently of the
 * module's own spherical formula so a sign error there cannot pass this.
 */
function windingOf(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum > 0 ? "ccw" : "cw";
}

const exteriorWinding = (f) => windingOf(
  f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]
);

describe("geoArea", function() {
  it("returns square metres for a ring", function() {
    // R² · Δλ · (sin φ₂ − sin φ₁) for a 1°x1° cell on the equator, using the
    // authalic radius: 12,364 km². Agrees with @turf/area to 5 significant figures.
    const km2 = geoArea(square(0, 0)) / 1e6;
    assert.closeTo(km2, 12364, 1);
  });

  it("subtracts interior rings", function() {
    const solid = geoArea(square(0, 0, 1));
    const holed = geoArea(squareWithHole(0, 0, 1, 0.5));
    assert.isBelow(holed, solid);
    assert.closeTo(holed / solid, 0.75, 0.02); // hole is 1/4 of the area
  });

  it("is zero for non-areal geometry", function() {
    assert.equal(geoArea({ type: "Point", coordinates: [0, 0] }), 0);
  });
});

describe("mergeShapes", function() {
  describe("union", function() {
    it("fuses two squares that share an edge into one ring", function() {
      const merged = mergeShapes([square(0, 0), square(1, 0)]);
      assert.equal(merged.geometry.type, "Polygon");
      assert.equal(diag(merged).outerRings, 1);
      assert.equal(diag(merged).holes, 0);
      assert.isTrue(diag(merged).contiguous);
    });

    it("conserves area when merging shapes that only touch", function() {
      const merged = mergeShapes([square(0, 0), square(1, 0)]);
      const parts = geoArea(square(0, 0)) + geoArea(square(1, 0));
      assert.closeTo(geoArea(merged.geometry), parts, parts * 1e-6);
    });

    it("keeps disjoint shapes as separate rings and reports non-contiguity", function() {
      const merged = mergeShapes([square(0, 0), square(10, 10)]);
      assert.equal(merged.geometry.type, "MultiPolygon");
      assert.equal(diag(merged).outerRings, 2);
      assert.isFalse(diag(merged).contiguous);
    });

    it("counts overlap only once", function() {
      const merged = mergeShapes([square(0, 0), square(0.5, 0)]);
      const parts = geoArea(square(0, 0)) + geoArea(square(0.5, 0));
      assert.isBelow(geoArea(merged.geometry), parts);
      assert.equal(diag(merged).outerRings, 1);
    });

    it("returns a single shape unchanged in area", function() {
      const merged = mergeShapes([square(0, 0)]);
      assert.closeTo(geoArea(merged.geometry), geoArea(square(0, 0)), 1);
    });
  });

  describe("input shapes", function() {
    it("accepts bare geometries, Features, and FeatureCollections alike", function() {
      const asGeometry = mergeShapes([square(0, 0), square(1, 0)]);
      const asFeatures = mergeShapes([feature(square(0, 0)), feature(square(1, 0))]);
      const asCollection = mergeShapes([
        { type: "FeatureCollection", features: [feature(square(0, 0)), feature(square(1, 0))] }
      ]);
      assert.deepEqual(asFeatures.geometry, asGeometry.geometry);
      assert.deepEqual(asCollection.geometry, asGeometry.geometry);
    });

    it("accepts MultiPolygon input", function() {
      const multi = { type: "MultiPolygon", coordinates: [square(0, 0).coordinates, square(10, 10).coordinates] };
      const merged = mergeShapes([multi]);
      assert.equal(diag(merged).outerRings, 2);
    });

    it("unwraps a GeometryCollection", function() {
      const gc = { type: "GeometryCollection", geometries: [square(0, 0), square(1, 0)] };
      assert.equal(diag(mergeShapes([gc])).outerRings, 1);
    });

    it("skips non-areal geometry and counts it", function() {
      const merged = mergeShapes([
        square(0, 0),
        { type: "Point", coordinates: [5, 5] },
        { type: "LineString", coordinates: [[0, 0], [1, 1]] }
      ]);
      assert.equal(diag(merged).skippedNonAreal, 2);
      assert.equal(diag(merged).outerRings, 1);
    });

    it("returns null when nothing areal is left", function() {
      assert.isNull(mergeShapes([{ type: "Point", coordinates: [0, 0] }]));
      assert.isNull(mergeShapes([]));
      assert.isNull(mergeShapes(null));
    });

    it("ignores null and undefined entries", function() {
      const merged = mergeShapes([square(0, 0), null, undefined, square(1, 0)]);
      assert.equal(diag(merged).outerRings, 1);
    });

    it("does not mutate its input", function() {
      const a = square(0, 0);
      const snapshot = JSON.stringify(a);
      mergeShapes([a, square(1, 0)]);
      assert.equal(JSON.stringify(a), snapshot);
    });
  });

  describe("despeckling", function() {
    // A ~111m x 111m hole is ~0.012 km², well under the 0.1 km² default.
    const TINY = 0.001;

    it("drops interior rings below minHoleArea and counts them", function() {
      const merged = mergeShapes([squareWithHole(0, 0, 1, TINY)]);
      assert.equal(diag(merged).holes, 0);
      assert.equal(diag(merged).holesDropped, 1);
    });

    it("keeps interior rings above minHoleArea", function() {
      const merged = mergeShapes([squareWithHole(0, 0, 1, 0.5)]);
      assert.equal(diag(merged).holes, 1);
      assert.equal(diag(merged).holesDropped, 0);
    });

    it("honours an explicit minHoleArea", function() {
      // Raise the threshold past a 0.5° hole (~3000 km²) and it too is dropped.
      const merged = mergeShapes([squareWithHole(0, 0, 1, 0.5)], { minHoleArea: 1e10 });
      assert.equal(diag(merged).holes, 0);
      assert.equal(diag(merged).holesDropped, 1);
    });

    it("can be disabled with minHoleArea: 0", function() {
      const merged = mergeShapes([squareWithHole(0, 0, 1, TINY)], { minHoleArea: 0 });
      assert.equal(diag(merged).holes, 1);
      assert.equal(diag(merged).holesDropped, 0);
    });
  });

  describe("winding", function() {
    // The bug these cover: polygon-clipping normalises its output to ccw
    // whatever it was handed, and the Illinois county data — like everything
    // d3-geo draws — is cw. Merging it used to return the complement of the
    // region, which renders as the whole world minus Illinois rather than as
    // nothing, so it does not announce itself.
    it("keeps a counterclockwise input counterclockwise", function() {
      assert.equal(exteriorWinding(mergeShapes([square(0, 0), square(1, 0)])), "ccw");
    });

    it("keeps a clockwise input clockwise", function() {
      const merged = mergeShapes([reverseRings(square(0, 0)), reverseRings(square(1, 0))]);
      assert.equal(exteriorWinding(merged), "cw");
    });

    it("winds interior rings opposite the exterior in either convention", function() {
      for (const wanted of ["ccw", "cw"]) {
        const merged = mergeShapes([squareWithHole(0, 0, 1, 0.5)], { winding: wanted, minHoleArea: 0 });
        const [outer, hole] = merged.geometry.coordinates;
        assert.equal(windingOf(outer), wanted, `exterior for ${wanted}`);
        assert.notEqual(windingOf(hole), wanted, `interior for ${wanted}`);
      }
    });

    it("forces a convention against the input's", function() {
      assert.equal(exteriorWinding(mergeShapes([square(0, 0)], { winding: "cw" })), "cw");
      assert.equal(exteriorWinding(mergeShapes([reverseRings(square(0, 0))], { winding: "ccw" })), "ccw");
    });

    it("does not change the area it reports", function() {
      const ccw = mergeShapes([square(0, 0)], { winding: "ccw" });
      const cw  = mergeShapes([square(0, 0)], { winding: "cw" });
      assert.equal(diag(cw).areaKm2, diag(ccw).areaKm2);
      assert.closeTo(geoArea(cw.geometry), geoArea(ccw.geometry), 1);
    });

    it("reports the winding it emitted", function() {
      assert.equal(diag(mergeShapes([square(0, 0)])).winding, "ccw");
      assert.equal(diag(mergeShapes([reverseRings(square(0, 0))])).winding, "cw");
    });

    it("rejects an unknown winding", function() {
      assert.throws(() => mergeShapes([square(0, 0)], { winding: "widdershins" }), /unknown winding/);
    });
  });

  describe("result", function() {
    it("carries caller properties alongside diagnostics", function() {
      const merged = mergeShapes([square(0, 0)], {
        properties: { "rdfs:label": "Greater Chicago Area", color: "#3388ff" }
      });
      assert.equal(merged.properties["rdfs:label"], "Greater Chicago Area");
      assert.equal(merged.properties.color, "#3388ff");
      assert.isObject(merged.properties["bold:mergeDiagnostics"]);
    });

    it("reports input, ring, area and vertex counts", function() {
      const d = diag(mergeShapes([square(0, 0), square(1, 0)]));
      assert.equal(d.inputs, 2);
      assert.equal(d.skippedNonAreal, 0);
      assert.isAbove(d.areaKm2, 0);
      assert.isAbove(d.vertices, 0);
    });

    it("omits diagnostics when asked", function() {
      const merged = mergeShapes([square(0, 0)], { diagnostics: false });
      assert.notProperty(merged.properties, "bold:mergeDiagnostics");
    });

    it("is a valid GeoJSON Feature", function() {
      const merged = mergeShapes([square(0, 0), square(1, 0)]);
      assert.equal(merged.type, "Feature");
      assert.isObject(merged.geometry);
      assert.isObject(merged.properties);
      assert.include(["Polygon", "MultiPolygon"], merged.geometry.type);
    });
  });
});
