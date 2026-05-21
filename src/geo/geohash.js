/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 */

import ngeohash from "ngeohash";

/**
 * Derive geohash precision from viewport bbox span.
 * Larger viewport → coarser cells so clusters stay readable.
 *
 * @param {{minLat:number, maxLat:number, minLng:number, maxLng:number}} bbox
 * @returns {number} geohash character length
 */
export function bboxToPrecision(bbox) {
  const span = Math.max(bbox.maxLat - bbox.minLat, bbox.maxLng - bbox.minLng);
  if (span > 40) return 2;
  if (span > 10) return 3;
  if (span > 2)  return 4;
  if (span > 0.5) return 5;
  if (span > 0.1) return 6;
  return 7;
}

/**
 * Lex +1 on the last base32 char of a geohash prefix, producing the exclusive
 * upper bound for a `_geohash` range query: docs whose geohash starts with
 * `prefix` satisfy `_geohash >= prefix && _geohash < incPrefix(prefix)`.
 *
 * Wraps at "z" by carrying — `incPrefix("z")` returns `"{"`, which sorts after
 * any base32 string and is therefore a safe exclusive upper bound.
 */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function incPrefix(prefix) {
  if (!prefix) return prefix;
  const chars = prefix.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = BASE32.indexOf(chars[i]);
    if (idx < BASE32.length - 1) {
      chars[i] = BASE32[idx + 1];
      return chars.join("");
    }
    chars[i] = BASE32[0];
  }
  // Carried past the most-significant char: return prefix + lex-greater suffix.
  return prefix + "~";
}

/**
 * Compute the buffered geohash cell set covering a viewport.
 *
 * Steps: enumerate cells via `ngeohash.bboxes`, add `ngeohash.neighbors` of
 * each cell as a one-cell buffer ring, then deduplicate. Going one level
 * coarser than the cluster precision keeps each buffer cell meaningfully
 * larger than viewport-edge slop.
 *
 * @param {{N:number, S:number, W:number, E:number}} bounds
 * @returns {{cells: string[], precision: number}}
 */
export function expandedRegionCells(bounds) {
  const precision = Math.max(1, bboxToPrecision({
    minLat: bounds.S, maxLat: bounds.N,
    minLng: bounds.W, maxLng: bounds.E,
  }) - 1);

  const inner = ngeohash.bboxes(bounds.S, bounds.W, bounds.N, bounds.E, precision);
  const set = new Set(inner);
  for (const cell of inner) {
    for (const nb of ngeohash.neighbors(cell)) set.add(nb);
  }
  return { cells: [...set], precision };
}
