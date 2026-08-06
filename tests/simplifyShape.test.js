/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { simplifyShape, simplifyRing, DEFAULT_TOLERANCE } from "../src/geo/simplify.js";

const feature = (geometry, properties = {}) => ({ type: "Feature", geometry, properties });
const diag = (f) => f.properties["bold:simplifyDiagnostics"];

/**
 * Winding of a ring by the shoelace sign, computed independently of the
 * module under test so a sign error there cannot pass this.
 */
function windingOf(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum > 0 ? "ccw" : "cw";
}

const exteriorOf = (f) => (
  f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]
);

/** Distance from p to segment a-b, written out again rather than imported. */
function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Smallest distance from p to any segment of the polyline. */
function distToPolyline(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, distToSegment(p, line[i], line[i + 1]));
  }
  return best;
}

/** A closed square ring with `perSide` extra collinear points on each side. */
function denseSquare(perSide) {
  const corners = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const ring = [];
  for (let c = 0; c < 4; c++) {
    const [x0, y0] = corners[c];
    const [x1, y1] = corners[(c + 1) % 4];
    ring.push([x0, y0]);
    for (let i = 1; i <= perSide; i++) {
      const t = i / (perSide + 1);
      ring.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  }
  ring.push([0, 0]);
  return { type: "Polygon", coordinates: [ring] };
}

const square = (x, y, size = 10) => ({
  type: "Polygon",
  coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
});

describe("simplifyRing", function() {
  it("drops interior points of a straight run", function() {
    const line = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
    assert.deepEqual(simplifyRing(line, 0.1), [[0, 0], [4, 0]]);
  });

  it("keeps a point that deviates by more than the tolerance", function() {
    const line = [[0, 0], [2, 1], [4, 0]];
    assert.deepEqual(simplifyRing(line, 0.5), [[0, 0], [2, 1], [4, 0]]);
  });

  it("drops a point that deviates by less than the tolerance", function() {
    const line = [[0, 0], [2, 0.1], [4, 0]];
    assert.deepEqual(simplifyRing(line, 0.5), [[0, 0], [4, 0]]);
  });

  it("is the identity at tolerance 0", function() {
    const line = [[0, 0], [2, 0.1], [4, 0]];
    assert.deepEqual(simplifyRing(line, 0), line);
  });

  it("passes through a line of two points or fewer", function() {
    assert.deepEqual(simplifyRing([[0, 0], [1, 1]], 5), [[0, 0], [1, 1]]);
    assert.deepEqual(simplifyRing([[0, 0]], 5), [[0, 0]]);
  });

  it("always retains both endpoints", function() {
    const line = [[0, 0], [1, 0.01], [2, 0.02], [3, 0]];
    const out = simplifyRing(line, 10);
    assert.deepEqual(out, [[0, 0], [3, 0]]);
  });
});

describe("simplifyShape", function() {
  it("reduces a dense square to its corners", function() {
    const out = simplifyShape(denseSquare(20), { tolerance: 0.001 });
    // Four corners plus the repeated first position.
    assert.equal(exteriorOf(out).length, 5);
    assert.deepEqual(exteriorOf(out)[0], exteriorOf(out)[4]);
  });

  it("keeps the ring closed", function() {
    const out = simplifyShape(denseSquare(8), { tolerance: 0.001 });
    const ring = exteriorOf(out);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
  });

  it("preserves winding in both directions", function() {
    const cw = square(0, 0);
    const ccw = { type: "Polygon", coordinates: [[...cw.coordinates[0]].reverse()] };

    assert.equal(
      windingOf(exteriorOf(simplifyShape(cw, { tolerance: 0.001 }))),
      windingOf(cw.coordinates[0]),
      "cw input must stay cw"
    );
    assert.equal(
      windingOf(exteriorOf(simplifyShape(ccw, { tolerance: 0.001 }))),
      windingOf(ccw.coordinates[0]),
      "ccw input must stay ccw"
    );
  });

  it("never displaces the outline by more than the tolerance", function() {
    // The guarantee that motivates choosing Douglas-Peucker: assert it
    // directly rather than trusting vertex counts. Every dropped position must
    // lie within tolerance of the retained polyline.
    const size = 10;
    const ring = [];
    for (let i = 0; i < 400; i++) {
      const t = (i / 400) * Math.PI * 2;
      // A circle with fine noise riding on it — the noise is what must go.
      const r = size + 0.02 * Math.sin(i * 7);
      ring.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    ring.push([ring[0][0], ring[0][1]]);

    const tolerance = 0.5;
    const out = simplifyShape({ type: "Polygon", coordinates: [ring] }, { tolerance });
    const kept = exteriorOf(out);

    assert.isBelow(kept.length, ring.length, "something should have been dropped");
    for (const p of ring) {
      assert.isAtMost(
        distToPolyline(p, kept),
        tolerance + 1e-9,
        `position ${JSON.stringify(p)} moved further than the tolerance`
      );
    }
  });

  it("simplifies interior rings and keeps them", function() {
    const outer = denseSquare(20).coordinates[0];
    const holeCorners = [[3, 3], [3, 7], [7, 7], [7, 3]];
    const hole = [];
    for (let c = 0; c < 4; c++) {
      const [x0, y0] = holeCorners[c];
      const [x1, y1] = holeCorners[(c + 1) % 4];
      hole.push([x0, y0]);
      for (let i = 1; i <= 10; i++) {
        const t = i / 11;
        hole.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      }
    }
    hole.push([3, 3]);

    const out = simplifyShape({ type: "Polygon", coordinates: [outer, hole] }, { tolerance: 0.001 });
    assert.equal(out.geometry.coordinates.length, 2, "the hole must survive");
    assert.equal(out.geometry.coordinates[1].length, 5, "hole reduced to its corners");
    assert.equal(diag(out).ringsIn, 2);
    assert.equal(diag(out).ringsOut, 2);
    assert.equal(diag(out).ringsDropped, 0);
  });

  it("drops a hole that collapses, and counts it", function() {
    const outer = square(0, 0, 100).coordinates[0];
    // A sliver far below the tolerance in both axes.
    const sliver = [[50, 50], [50.0001, 50], [50.0001, 50.0001], [50, 50.0001], [50, 50]];

    const out = simplifyShape({ type: "Polygon", coordinates: [outer, sliver] }, { tolerance: 0.01 });
    assert.equal(out.geometry.coordinates.length, 1, "only the exterior remains");
    assert.equal(diag(out).ringsDropped, 1);
    assert.equal(diag(out).ringsOut, 1);
  });

  it("handles a MultiPolygon", function() {
    const multi = {
      type: "MultiPolygon",
      coordinates: [denseSquare(10).coordinates, square(50, 50).coordinates]
    };
    const out = simplifyShape(multi, { tolerance: 0.001 });
    assert.equal(out.geometry.type, "MultiPolygon");
    assert.equal(out.geometry.coordinates.length, 2);
  });

  it("accepts a Feature and returns a Feature", function() {
    const out = simplifyShape(feature(denseSquare(6)), { tolerance: 0.001 });
    assert.equal(out.type, "Feature");
    assert.equal(out.geometry.type, "Polygon");
  });

  it("returns null for non-areal or empty input", function() {
    assert.isNull(simplifyShape(null));
    assert.isNull(simplifyShape({ type: "Point", coordinates: [0, 0] }));
    assert.isNull(simplifyShape({ type: "LineString", coordinates: [[0, 0], [1, 1]] }));
    assert.isNull(simplifyShape({ type: "Polygon", coordinates: [] }));
  });

  it("is idempotent — simplifying twice changes nothing further", function() {
    const once = simplifyShape(denseSquare(30), { tolerance: 0.05 });
    const twice = simplifyShape(once, { tolerance: 0.05 });
    assert.deepEqual(twice.geometry.coordinates, once.geometry.coordinates);
  });

  it("carries opts.properties onto the result", function() {
    const out = simplifyShape(square(0, 0), { properties: { "rdfs:label": "Test" } });
    assert.equal(out.properties["rdfs:label"], "Test");
  });

  it("reports diagnostics, and omits them when asked", function() {
    const out = simplifyShape(denseSquare(20), { tolerance: 0.001 });
    const d = diag(out);
    assert.equal(d.tolerance, 0.001);
    assert.equal(d.verticesIn, denseSquare(20).coordinates[0].length);
    assert.equal(d.verticesOut, 5);
    assert.isNumber(d.areaKm2);
    assert.isNumber(d.areaDeltaPct);

    const bare = simplifyShape(denseSquare(20), { tolerance: 0.001, diagnostics: false });
    assert.isUndefined(bare.properties["bold:simplifyDiagnostics"]);
  });

  it("barely changes area when the tolerance is sub-pixel", function() {
    const out = simplifyShape(denseSquare(40), { tolerance: DEFAULT_TOLERANCE });
    assert.isBelow(Math.abs(diag(out).areaDeltaPct), 0.5);
  });

  it("scales longitude so the tolerance is isotropic", function() {
    // At 60N, cos(60) = 0.5: a degree of longitude covers half the ground
    // distance of a degree of latitude. Two bumps of the same *angular* size,
    // one displaced north and one displaced east, are therefore different
    // physical sizes, and a tolerance between them must drop only the eastward
    // one. Without the cos(meanLat) correction both read as `bump` and the two
    // survive or die together.
    const lat = 60;
    const bump = 0.02;

    const ring = [
      [0, lat],
      [1, lat + bump],   // displaced in LATITUDE  -> planar deviation  bump
      [2, lat],
      [2, lat + 2],
      [0, lat + 2],
      [bump, lat + 1],   // displaced in LONGITUDE -> planar deviation  bump * 0.5
      [0, lat]
    ];

    const out = simplifyShape({ type: "Polygon", coordinates: [ring] }, { tolerance: bump * 0.75 });
    const kept = exteriorOf(out);
    const has = (pred) => kept.some(pred);

    assert.isTrue(
      has((p) => Math.abs(p[1] - (lat + bump)) < 1e-9),
      "the northward bump is larger than the tolerance and must survive"
    );
    assert.isFalse(
      has((p) => p[0] > 1e-9 && p[0] < 0.5),
      "the eastward bump is physically smaller and must be dropped"
    );
  });
});
