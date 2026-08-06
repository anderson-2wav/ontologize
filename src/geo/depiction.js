/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Selecting among several depictions of one resource.
 *
 * `bold:spatialDepiction` is multi-valued, and a resource can carry the same
 * geometry at more than one fidelity or from more than one source. Illinois
 * holds a 21,667-vertex merged outline for analysis and a ~200-vertex
 * simplification for thumbnails; the counties hold an IDOT and a Click-that-Hood
 * version of each boundary.
 *
 * Pure: no Mongo, no Meteor. The instance-bound reader is
 * `GeoApi#getSpatialDepiction`, via its `depictionRole` option.
 */

/**
 * Where a depiction records what it is for.
 *
 * Prefixed, unlike the bare `NAME_LC` / `cartodb_id` markers
 * `server/lib/gov-counties.mjs` matches on: those are shapefile attributes that
 * happened to be unique to their source, and a bare `role` or `thumbnail` could
 * collide with some future dataset's own attribute. Deliberately not part of
 * the un-prefixed rendering-hint namespace (`color`, `alpha`, `smooth`) that
 * `GeoShapePlugin` reads — those tell a renderer how to paint, this tells a
 * caller which geometry to take.
 */
export const DEPICTION_ROLE_KEY = "bold:depictionRole";

/**
 * Known roles. A string enum rather than a `simplified: true` boolean so a
 * third fidelity costs no new key and a caller asks for what it wants by name.
 */
export const DEPICTION_ROLES = ["detail", "thumbnail"];

/** The role a depiction carries when it says nothing. */
export const DEFAULT_DEPICTION_ROLE = "detail";

/**
 * Pick the depiction carrying `role`.
 *
 * Only non-default roles are tagged, so a resource with one untagged depiction
 * still resolves as `detail` — the marker-then-position rule
 * `server/lib/gov-counties.mjs` uses, and what keeps the 102 untagged county
 * pairs working unchanged.
 *
 * Named for the axis it selects on: that file already exports a `pickDepiction`
 * which selects by *source*, and two same-named selectors on different axes is
 * a trap worth spending a longer name to avoid.
 *
 * @param {Array<object>|object} depictions - the stored property value
 * @param {string} role - one of DEPICTION_ROLES
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] - when false, asking for the default
 *   role falls back to the first entry. When true, only an explicit match (or
 *   an untagged entry for the default role) answers, and anything else is null.
 *   Callers shipping a payload to a browser want `strict`: a non-strict miss on
 *   "thumbnail" hands back the full-detail geometry, which is the opposite of
 *   what they asked for and three orders of magnitude larger.
 * @returns {object|null}
 */
export function pickDepictionByRole(depictions, role, opts = {}) {
  const list = Array.isArray(depictions) ? depictions : (depictions ? [depictions] : []);
  if (list.length === 0) return null;

  const matched = list.find((d) => d?.properties?.[DEPICTION_ROLE_KEY] === role);
  if (matched) return matched;

  // An untagged entry means the default role, whether or not `strict` is set:
  // that is what "untagged" has always meant, not a guess.
  if (role === DEFAULT_DEPICTION_ROLE) {
    const untagged = list.find((d) => d && d.properties?.[DEPICTION_ROLE_KEY] === undefined);
    if (untagged) return untagged;
  }

  if (opts.strict) return null;
  return list[0] ?? null;
}

/**
 * Tag a Feature with its role, without mutating the input.
 *
 * @param {object} feature - a GeoJSON Feature
 * @param {string} role - one of DEPICTION_ROLES
 * @returns {object} a copy carrying the role
 */
export function withDepictionRole(feature, role) {
  return {
    ...feature,
    properties: { ...(feature.properties ?? {}), [DEPICTION_ROLE_KEY]: role }
  };
}
