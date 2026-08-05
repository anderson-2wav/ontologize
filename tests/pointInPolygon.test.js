/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 */

import { assert } from "chai";
import { pointInPolygon, pointInGeometry } from "../src/geo/pointInPolygon.js";

// A 10×10 square with a 2×2 hole in the middle. Coordinates are [lng, lat].
const SQUARE = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
const SQUARE_WITH_HOLE = [
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
];

describe("pointInPolygon", function() {
  it("finds a point inside the ring", function() {
    assert.isTrue(pointInPolygon([5, 5], SQUARE));
  });

  it("rejects a point outside the ring", function() {
    assert.isFalse(pointInPolygon([15, 5], SQUARE));
  });

  it("rejects a point inside a hole", function() {
    assert.isFalse(pointInPolygon([5, 5], SQUARE_WITH_HOLE));
  });

  it("accepts a point inside the ring but outside the hole", function() {
    assert.isTrue(pointInPolygon([2, 2], SQUARE_WITH_HOLE));
  });

  it("returns false for empty or malformed rings", function() {
    assert.isFalse(pointInPolygon([5, 5], []));
    assert.isFalse(pointInPolygon([5, 5], null));
  });
});

describe("pointInGeometry", function() {
  it("handles a Polygon", function() {
    assert.isTrue(pointInGeometry([5, 5], { type: "Polygon", coordinates: SQUARE }));
  });

  it("handles a MultiPolygon, matching either part", function() {
    const far = [[[100, 0], [110, 0], [110, 10], [100, 10], [100, 0]]];
    const geometry = { type: "MultiPolygon", coordinates: [SQUARE, far] };
    assert.isTrue(pointInGeometry([5, 5], geometry));
    assert.isTrue(pointInGeometry([105, 5], geometry));
    assert.isFalse(pointInGeometry([50, 5], geometry));
  });

  it("unwraps a Feature", function() {
    const feature = { type: "Feature", geometry: { type: "Polygon", coordinates: SQUARE } };
    assert.isTrue(pointInGeometry([5, 5], feature));
  });

  it("returns false rather than throwing on unusable geometry", function() {
    assert.isFalse(pointInGeometry([5, 5], null));
    assert.isFalse(pointInGeometry([5, 5], { type: "Point", coordinates: [5, 5] }));
    assert.isFalse(pointInGeometry([5, 5], { type: "Polygon" }));
  });

  // Ray casting is half-open by construction: it counts a crossing when
  // exactly one endpoint is strictly above the ray. A point on an edge or
  // vertex therefore lands on one side deterministically, which is all this
  // asserts — region membership at 1.2 km cell granularity does not care
  // which side, only that the answer is stable and never throws.
  it("answers deterministically on a vertex without throwing", function() {
    const first = pointInPolygon([0, 0], SQUARE);
    assert.isBoolean(first);
    assert.equal(pointInPolygon([0, 0], SQUARE), first);
  });
});
