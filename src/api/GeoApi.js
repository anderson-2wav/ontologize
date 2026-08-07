/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check } from "../lib/check.js";
import { getSunriseSunsetInfo } from "sunrise-sunset-api";
import { ApiNamespace } from "./ApiNamespace.js";
import { mergeShapes } from "../geo/merge.js";
import { getSpatialRange, positionsOf, HULL_TYPES } from "../geo/range.js";
import { simplifyShape, DEFAULT_TOLERANCE } from "../geo/simplify.js";
import { pickDepictionByRole, withDepictionRole } from "../geo/depiction.js";
import { pointInGeometry, geometryBbox, pointInBbox } from "../geo/pointInPolygon.js";
import { buildSummaryPipeline, mergeSummaries, centroidsForCells, tagRegions } from "../geo/groupSummary.js";
import { h3FieldName, PARENT_RESOLUTIONS } from "../geo/h3.js";
import { Query } from "../Query.js";

/**
 * `ontologize.geo` — instance-bound geospatial helpers: derive a resource's
 * spatial depiction as GeoJSON, and look up solar events.
 *
 * The pure, instance-free viewport/H3/geohash helpers used by the GeoView
 * cell-cache (`bboxToH3Cells`, `bufferRing`, `zoomToH3Resolution`, …) live in
 * `../geo/` and are exported from the `ontologize/geo` subpath. They are
 * re-exported at the bottom of this file for convenience so callers holding an
 * Ontologize instance can reach them without a second import; nothing about the
 * `ontologize/geo` / `ontologize/geo-server` subpaths changes.
 */

/**
 * The individual ids a group value names.
 *
 * A link property arrives in more than one shape: a bare id string, an
 * `{"@id": …}` reference, or an array of either when a geo resource belongs to
 * several individuals. Normalising here means the bucketing loop stays a lookup.
 *
 * @param {*} value - the raw value of the group property on a geo resource
 * @returns {string[]} individual ids, empty when the value names none
 * @private
 */
function groupKeysOf(value) {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(v => (v && typeof v === "object" ? (v["@id"] ?? v._id ?? null) : v))
    .filter(v => typeof v === "string" && v.length > 0);
}

export class GeoApi extends ApiNamespace {
  /**
   * Docs processed between yields to the event loop while resolving depictions.
   * Matches OntologizeServer.YIELD_EVERY: a long loop that never yields blocks
   * every other request for its whole duration.
   */
  static YIELD_EVERY = 100;

  /** Write operations per bulkWrite call. */
  static WRITE_CHUNK = 500;

  /** Default stored H3 resolution summarised (~1.2 km cells). */
  static SUMMARY_CELL_RES = 7;

  /** Ceiling on centroids returned across all groups before stepping coarser. */
  static SUMMARY_MAX_CELLS = 20000;

  /** Collection `outline` scans for containing regions. */
  static OUTLINE_COLLECTION = "gov";

  /** `@type` an `outline` candidate must carry. */
  static OUTLINE_TYPE = "gov:State";

  /**
   * Depiction role `outline` returns. Thumbnail, always: the caller is a 100px
   * figure, and the detail geometry is ~100x larger.
   */
  static OUTLINE_ROLE = "thumbnail";

  /**
   * Get sunrise and sunset times for a location and date.
   *
   * Uses the sunrise-sunset.org API to get solar event times.
   *
   * @param {number[]} longLat - Array of [longitude, latitude]
   * @param {Date|string|number|object} date - The date (accepts same formats as formatDate)
   * @param {object} [opts] - Options (reserved for future use)
   * @returns {Promise<object>} Sunrise/sunset info with ISO date strings
   * @throws {Error} If the API call fails or parameters are invalid
   */
  async getSunriseSunset(longLat, date, opts = {}) {
    // Validate longLat
    if (!Array.isArray(longLat) || longLat.length !== 2) {
      throw new Error("longLat must be an array of [longitude, latitude]");
    }
    const [longitude, latitude] = longLat;
    if (typeof longitude !== "number" || typeof latitude !== "number") {
      throw new Error("longitude and latitude must be numbers");
    }
    opts.formatted = opts.formatted === true;

    // Extract the date value (same logic as formatDate)
    let dateValue = date;
    if (typeof date === "object" && date !== null && !(date instanceof Date)) {
      if (date["@value"] !== undefined) {
        dateValue = date["@value"];
      }
    }

    // Convert to Date object
    let dateObj;
    if (dateValue instanceof Date) {
      dateObj = dateValue;
    }
    else if (typeof dateValue === "string" || typeof dateValue === "number") {
      dateObj = new Date(dateValue);
    }
    else {
      throw new Error("Invalid date value");
    }

    if (isNaN(dateObj.getTime())) {
      throw new Error("Invalid date value");
    }

    // Format date as YYYY-MM-DD for the API
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    const dateString = `${year}-${month}-${day}`;

    // Call the sunrise-sunset API
    const response = await getSunriseSunsetInfo({
      latitude,
      longitude,
      date: dateString,
      formatted: opts.formatted
    });

    return response;
  }

  /**
   * Get the spatial depiction of a resource as GeoJSON.
   *
   * Checks for spatial data in this order of preference:
   * 1. `geo:lat` and `geo:long` properties — synthesises a `Point` geometry
   * 2. Any property with `rdfs:range` of `bold:GeoPoint`
   * 3. Any property with `rdfs:range` of `bold:GeoJSON` (e.g. `bold:spatialDepiction`)
   *
   * **The contract is a GeoJSON *object*, not specifically a Feature.** A
   * depiction legitimately arrives as any of the GeoJSON object types:
   * pattern 1 synthesises a bare `Point` geometry, while patterns 2 and 3 hand
   * back whatever the property holds — commonly a `Feature` (as
   * `bold:spatialDepiction` does for `gov:County`), but equally a `Geometry`,
   * `FeatureCollection`, or `GeometryCollection`. Narrowing the return to
   * `Feature` would mean inventing a wrapper for geometries and choosing how to
   * collapse a `FeatureCollection`, so the union is deliberate.
   *
   * Callers branch on `type` and wrap a bare geometry when they need a Feature —
   * see `ResourceGeoView`'s `isGeoJSONGeometry` branch. A multi-valued property
   * yields its first value, unless `opts.depictionRole` asks for another.
   *
   * @param {object} resource - The resource to get the depiction for
   * @param {object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups
   * @param {string} [opts.depictionRole] - select the depiction whose
   *   `properties["bold:depictionRole"]` matches, rather than the first. See
   *   `../geo/depiction.js`.
   * @param {boolean} [opts.strictRole=false] - with a role requested, answer
   *   null rather than falling back to the first depiction. Callers shipping a
   *   payload to a browser want this: a non-strict miss on "thumbnail" hands
   *   back the full-detail geometry, which for Illinois is 100x larger.
   * @returns {Promise<object|null>} A GeoJSON object — Feature, FeatureCollection,
   *   Geometry, or GeometryCollection — or null if the resource has no spatial data
   */
  async getSpatialDepiction(resource, opts = {}) {
    check(resource, Object);
    const cache = opts.ontologyCache;

    // Pattern 1: Check for geo:lat and geo:long properties
    const lat = this._extractNumericValue(resource["geo:lat"]);
    const lng = this._extractNumericValue(resource["geo:long"]);

    if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
      return {
        type: "Point",
        coordinates: [lng, lat]  // GeoJSON uses [lng, lat] order
      };
    }

    // Pattern 2 & 3: Check for properties with rdfs:range of bold:GeoPoint or bold:GeoJSON
    // We need to scan resource properties and look up their ontology definitions
    for (const propertyName of Object.keys(resource)) {
      // Skip special properties
      if (propertyName.startsWith("@") || propertyName === "_id") {
        continue;
      }

      const propertyValue = resource[propertyName];
      if (propertyValue === null || propertyValue === undefined) {
        continue;
      }

      // Look up property definition in ontology
      const propertyDef = await this.ontologize._cachedOntologyLookup(propertyName, cache);
      if (!propertyDef) {
        continue;
      }

      const range = propertyDef["rdfs:range"];
      if (!range) {
        continue;
      }

      // Handle range as string or object with @id
      const rangeValue = typeof range === "object" ? (range["@id"] || range._id) : range;

      // Pattern 2: bold:GeoPoint
      if (rangeValue === "bold:GeoPoint") {
        const geoPoint = this._parseGeoValue(propertyValue);
        if (geoPoint) {
          return geoPoint;
        }
      }

      // Pattern 3: bold:GeoJSON
      if (rangeValue === "bold:GeoJSON") {
        const geoJson = this._selectGeoValue(propertyName, propertyValue, resource, opts);
        if (geoJson) {
          return geoJson;
        }
      }
    }

    // No location found
    return null;
  }

  /**
   * Merge several resources' spatial depictions into one Feature covering their
   * union — an IDNR region from its counties, or Illinois from all 102 of them.
   * Interior borders dissolve.
   *
   * Each resource contributes one depiction: the first, or whichever
   * `opts.select` picks. Resources whose depiction is non-areal (a point, a
   * line) are skipped rather than rejected, and ids that resolve to nothing are
   * counted — both land in `properties["bold:mergeDiagnostics"]` along with
   * `holesDropped`, which is the signal that the inputs disagreed. Callers
   * building a region should assert `holesDropped === 0 && contiguous`.
   *
   * See `.private/specs/ontologize/ontologize-geo-spec.md` for why sliver holes
   * appear (mixed provenance, not imprecision) and why snapping does not fix them.
   *
   * Like `getSpatialDepiction`, this needs the ontology loaded: a depiction is
   * only recognised once its property's `rdfs:range` is known to be
   * `bold:GeoJSON` / `bold:GeoPoint`. Against an empty Ontology collection every
   * resource resolves to nothing and the result is null.
   *
   * @param {Array<string|object>|string|object} resources - resource ids or
   *   resources, or a single one of either
   * @param {object} [opts]
   * @param {object} [opts.properties] - properties for the resulting Feature
   * @param {number} [opts.minHoleArea=100000] - m²; interior rings below this
   *   are dropped as slivers. Pass 0 to keep every ring.
   * @param {function} [opts.select] - `(depictions, resource) => depiction`,
   *   for resources carrying more than one depiction
   * @param {boolean} [opts.diagnostics=true] - attach `bold:mergeDiagnostics`
   * @param {Map} [opts.ontologyCache] - cache Map for ontology lookups
   * @returns {Promise<object|null>} a GeoJSON Feature, or null if nothing areal
   *   could be resolved
   */
  async mergeShapes(resources, opts = {}) {
    const list = Array.isArray(resources) ? resources : (resources ? [resources] : []);
    const shapes = [];
    let unresolved = 0;

    for (const entry of list) {
      let resource = entry;
      if (typeof entry === "string") {
        const found = await this.ontologize.getResourceForId(entry);
        resource = found?.resource ?? null;
      }
      if (!resource) {
        unresolved++;
        continue;
      }

      let shape;
      if (opts.select) {
        // An LD proxy collapses a multi-valued property to its first value, so
        // reach through __raw to offer the selector every depiction.
        const raw = resource.__raw?.["bold:spatialDepiction"] ?? resource["bold:spatialDepiction"];
        const depictions = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        shape = opts.select(depictions, resource);
      }
      else {
        shape = await this.getSpatialDepiction(resource, opts);
      }

      if (shape) shapes.push(shape);
      else unresolved++;
    }

    const merged = mergeShapes(shapes, opts);
    if (merged && opts.diagnostics !== false) {
      merged.properties["bold:mergeDiagnostics"].requested = list.length;
      merged.properties["bold:mergeDiagnostics"].unresolved = unresolved;
    }
    return merged;
  }

  /**
   * Build a resource's whole `bold:spatialDepiction` value: the merged
   * full-detail outline, plus a simplified thumbnail of it.
   *
   * Two fidelities of one shape, because they answer different questions. The
   * detail outline is what area, containment and merge operations need. The
   * thumbnail is what a 100px panel needs, and shipping the detail there means
   * ~780 KB for Illinois where 8 KB is indistinguishable.
   *
   * A wrapper rather than an option on `mergeShapes`, whose Feature return
   * every caller destructures — a flag that conditionally changed the return
   * type to a pair would break them all.
   *
   * **Order is load-bearing.** `_parseGeoValue` takes `value[0]`, so the
   * full-detail shape must stay first: every existing consumer reads the array
   * without knowing about roles and must keep getting detail. Only the
   * thumbnail is tagged, matching the marker-then-position rule in
   * `../geo/depiction.js`.
   *
   * @param {Array<string|object>|string|object} resources - what to merge; see
   *   `mergeShapes`
   * @param {object} [opts] - everything `mergeShapes` takes, plus:
   * @param {number} [opts.tolerance=DEFAULT_TOLERANCE] - thumbnail simplification
   *   tolerance, in degrees of latitude
   * @param {boolean} [opts.thumbnail=true] - set false to get `[detail]` alone
   * @returns {Promise<Array<object>|null>} `[detail, thumbnail]`, `[detail]`, or
   *   null if nothing areal could be resolved
   */
  async buildDepictions(resources, opts = {}) {
    const detail = await this.mergeShapes(resources, opts);
    if (!detail) return null;
    if (opts.thumbnail === false) return [detail];

    const thumbnail = simplifyShape(detail, {
      tolerance: opts.tolerance ?? DEFAULT_TOLERANCE,
      // Carry the label so the thumbnail is self-describing, but not the merge
      // diagnostics: those record how the *detail* shape was built, and the
      // thumbnail keeps its own provenance in bold:simplifyDiagnostics.
      properties: detail.properties?.["rdfs:label"]
        ? { "rdfs:label": detail.properties["rdfs:label"] }
        : {}
    });
    if (!thumbnail) return [detail];

    return [detail, withDepictionRole(thumbnail, "thumbnail")];
  }

  /**
   * The small outline of the region containing a point — the map a thumbnail
   * draws a home range against.
   *
   * `bold-vue`'s `SpatialRangeValue` calls this as the `geo.outline` RPC method
   * to place an animal's range inside its state in a ~100px figure. It answers
   * the containing region rather than a fixed one because the renderer fires
   * for any `bold:Animal` subclass: `orju:Bird` resolves to California, and a
   * hard-coded Illinois would draw the wrong map with the dot off canvas.
   * Adding a state is then a data change — bootstrap `gov:state-CA` with a
   * `[detail, thumbnail]` pair and it resolves with no code edit.
   *
   * **Only the thumbnail depiction is ever returned**, and null rather than the
   * full-detail geometry when a region has none: `strictRole` is what keeps a
   * 778 KB Illinois polygon out of a popup that asked for 8 KB. See
   * `../geo/depiction.js`.
   *
   * It takes an id or a coordinate pair and **no selector**, unlike
   * `getGroupSummary` — which is what makes it safe to expose directly to a
   * browser without the server-owns-the-selector precaution that method needs.
   *
   * Like `getSpatialDepiction`, this needs the ontology loaded: a depiction is
   * only recognised once `bold:spatialDepiction`'s `rdfs:range` is known to be
   * `bold:GeoJSON`. Against an empty Ontology collection this is always null.
   *
   * Resolved outlines are memoised on the instance, keyed by collection, role
   * and id — they are bootstrap shapes, so the cache is never invalidated;
   * `clearOutlineCache()` exists for tests and for anything that reloads region
   * data in-process. Only thumbnails are held: caching detail geometry would be
   * ~780 KB per resident state.
   *
   * @param {object} [opts]
   * @param {string} [opts.resourceId] - a specific region, e.g. `"gov:state-IL"`.
   *   Wins over `point` when both are given.
   * @param {[number, number]} [opts.point] - `[lng, lat]`; the region containing
   *   it. GeoJSON order, matching `bold:spatialRange.properties.centroid.coordinates`
   *   — nothing to swap.
   * @param {string} [opts.collection="gov"] - registered collection to look in.
   *   An unregistered name is null, not a throw: a host that has not bootstrapped
   *   region data should degrade to a rangeless figure, not a 500.
   * @param {string} [opts.type="gov:State"] - `@type` a candidate must carry,
   *   for the `point` scan
   * @param {string} [opts.depictionRole="thumbnail"] - which fidelity to return
   * @returns {Promise<{_id: string, label: string, feature: object}|null>} null
   *   when nothing contains the point, or when the match carries no depiction in
   *   the requested role — never a depiction in another role
   */
  async outline(opts = {}) {
    const collectionName = opts.collection ?? GeoApi.OUTLINE_COLLECTION;
    const collection = this.collections[collectionName];
    if (!collection) return null;

    const role = opts.depictionRole ?? GeoApi.OUTLINE_ROLE;
    // One cache per call, shared across every candidate: the property lookup
    // for bold:spatialDepiction is the same for all of them.
    const ontologyCache = new Map();

    if (opts.resourceId) {
      const doc = await collection.findOne({ _id: opts.resourceId });
      if (!doc) return null;
      const entry = await this._outlineFor(doc, collectionName, role, ontologyCache);
      return entry?.result ?? null;
    }

    const point = opts.point;
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [lng, lat] = point;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

    const docs = await collection.find({ "@type": opts.type ?? GeoApi.OUTLINE_TYPE }).toArray();
    for (const doc of docs) {
      const entry = await this._outlineFor(doc, collectionName, role, ontologyCache);
      if (!entry) continue;
      // Tested against the thumbnail, not the detail ring: 218 vertices rather
      // than 21,667, and accurate to ~1 km, which is far more than "which
      // state" needs. The bbox prefilter makes the common case one comparison.
      if (entry.bbox && !pointInBbox([lng, lat], entry.bbox)) continue;
      if (pointInGeometry([lng, lat], entry.result.feature)) return entry.result;
    }
    return null;
  }

  /** Drop the memoised outlines. For tests, and for in-process data reloads. */
  clearOutlineCache() {
    this._outlineCache?.clear();
  }

  /**
   * One region's outline, memoised.
   *
   * Returns the bbox alongside the payload so the scan does not recompute it
   * per point, and a `result` object that is exactly what `outline` returns —
   * the bbox is a scan detail and has no business on the wire.
   *
   * @param {object} doc - a region resource
   * @param {string} collectionName
   * @param {string} role - depiction role
   * @param {Map} ontologyCache
   * @returns {Promise<{result: object, bbox: Array<number>|null}|null>}
   * @private
   */
  async _outlineFor(doc, collectionName, role, ontologyCache) {
    const id = doc._id ?? doc["@id"];
    if (!id) return null;

    this._outlineCache ??= new Map();
    // NUL as the separator, as HttpCollectionAdapter#_key does: it cannot occur
    // in a collection name, a role or a QName, so no pair of parts can collide.
    // Written as an escape, never as a literal byte — a raw NUL in source makes
    // grep and diff treat the whole file as binary.
    const key = `${collectionName}\u0000${role}\u0000${id}`;
    if (this._outlineCache.has(key)) return this._outlineCache.get(key);

    const feature = await this.getSpatialDepiction(doc, {
      depictionRole: role,
      strictRole: true,
      ontologyCache
    });

    const label = Array.isArray(doc["rdfs:label"]) ? doc["rdfs:label"][0] : doc["rdfs:label"];
    const entry = feature
      ? { result: { _id: id, label: label ?? id, feature }, bbox: geometryBbox(feature) }
      : null;
    this._outlineCache.set(key, entry);
    return entry;
  }

  /**
   * The hull enclosing several resources' spatial data — an animal's home range
   * from its tracking reports, suitable for storing as `bold:spatialRange`.
   *
   * Where `mergeShapes` unions areas, this reads *positions*: a mix of points,
   * lines and polygons is ordinary input, and every vertex counts the same.
   * Resources contributing no position are counted as `unresolved` rather than
   * rejected, so one bad id shrinks the range visibly instead of silently.
   *
   * `hullType: "concave"` uses the same alpha-shape rule as
   * `bold-vue/geo-plugins/hullUtils.js`, so a stored range agrees with the hull
   * `RangeExtentPlugin` draws live for the same points.
   *
   * Like `getSpatialDepiction`, this needs the ontology loaded: a depiction is
   * only recognised once its property's `rdfs:range` is known to be
   * `bold:GeoJSON` / `bold:GeoPoint`. Against an empty Ontology collection every
   * resource resolves to nothing and the result is null.
   *
   * @param {Array<string|object>|string|object} resources - resource ids or
   *   resources, or a single one of either
   * @param {object} [opts]
   * @param {object} [opts.properties] - properties for the resulting Feature
   * @param {"convex"|"concave"} [opts.hullType="convex"] - boundary shape
   * @param {number} [opts.alpha=0.5] - concavity, 0…1; `concave` only
   * @param {"cw"|"ccw"} [opts.winding="cw"] - exterior-ring winding; defaults to
   *   the d3-geo / `2dsphere` convention the rest of BOLD uses
   * @param {function} [opts.select] - `(depictions, resource) => depiction`,
   *   for resources carrying more than one depiction
   * @param {boolean} [opts.diagnostics=true] - attach `bold:rangeDiagnostics`
   * @param {Map} [opts.ontologyCache] - cache Map for ontology lookups
   * @returns {Promise<object|null>} a GeoJSON Feature, or null if fewer than 3
   *   distinct positions could be resolved
   */
  async getSpatialRange(resources, opts = {}) {
    const list = Array.isArray(resources) ? resources : (resources ? [resources] : []);
    const shapes = [];
    let unresolved = 0;

    for (const entry of list) {
      let resource = entry;
      if (typeof entry === "string") {
        const found = await this.ontologize.getResourceForId(entry);
        resource = found?.resource ?? null;
      }
      if (!resource) {
        unresolved++;
        continue;
      }

      let shape;
      if (opts.select) {
        // An LD proxy collapses a multi-valued property to its first value, so
        // reach through __raw to offer the selector every depiction.
        const raw = resource.__raw?.["bold:spatialDepiction"] ?? resource["bold:spatialDepiction"];
        const depictions = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        shape = opts.select(depictions, resource);
      }
      else {
        shape = await this.getSpatialDepiction(resource, opts);
      }

      if (shape) shapes.push(shape);
      else unresolved++;
    }

    const range = getSpatialRange(shapes, opts);
    if (range && opts.diagnostics !== false) {
      range.properties["bold:rangeDiagnostics"].requested = list.length;
      range.properties["bold:rangeDiagnostics"].unresolved = unresolved;
    }
    return range;
  }

  /**
   * A registered collection, or a throw naming what is registered.
   *
   * A missing collection would otherwise range nothing and report zeroes, which
   * reads exactly like data that is genuinely absent.
   *
   * @param {string} name - registered collection name
   * @returns {object} the collection
   * @private
   */
  _requireCollection(name) {
    const collection = this.collections[name];
    if (!collection) {
      throw new Error(
        `updateSpatialRange: unknown collection "${name}" — registered: ${Object.keys(this.collections).join(", ")}`
      );
    }
    return collection;
  }

  /**
   * Per-group facts for the GeoView group selector: time bounds, document
   * count, a compact spatial footprint, and region tags.
   *
   * The counterpart of `geo.getGroupResources`, which answers only "which
   * resources does this query reference". This answers "and what is true of
   * each of them", in one round trip, without shipping the geo documents: 761
   * cell centroids stand in for 32,732 collar reports.
   *
   * Facts only — no filtering, sorting, or paging, and no user location. The
   * client applies predicates to what comes back, which is what lets filters
   * move server-side later without changing this vocabulary.
   *
   * See `.private/specs/crittertrack/animal-selector-filters-spec.md` §4.
   *
   * @param {object} opts
   * @param {Array<{dataCollection: string, dataSelector: object, resourceCollection: string}>} opts.queries
   * @param {string} [opts.groupProperty="bold:animal"]
   * @param {number} [opts.cellRes=7] - stored H3 resolution to summarise
   * @param {string[]} [opts.fields] - roster projection; omit for whole documents
   * @param {number} [opts.maxCells=20000] - ceiling before stepping coarser
   * @param {{collection: string, selector: object, geometryProperty: string}} [opts.regions]
   * @param {string} [opts.timeProperty="_whenMs"]
   * @returns {Promise<{resources: object[], summary: object, regions: object[], meta: object}>}
   * @throws {Error} if a data or resource collection is not registered. A bad
   *   *region* config does not throw: region tagging degrades to no tags and
   *   `meta.regionsAvailable: false`, so the roster still returns.
   */
  async getGroupSummary(opts = {}) {
    const queries = Array.isArray(opts.queries) ? opts.queries : [];
    const groupProperty = opts.groupProperty ?? "bold:animal";
    const timeProperty = opts.timeProperty ?? "_whenMs";
    const maxCells = opts.maxCells ?? GeoApi.SUMMARY_MAX_CELLS;

    // Resolution ladder: the requested resolution, then every coarser stored
    // one. h3FieldName throws for resolutions the importer never wrote, so a
    // bad cellRes fails here rather than silently matching no documents.
    const requestedRes = opts.cellRes ?? GeoApi.SUMMARY_CELL_RES;
    const ladder = PARENT_RESOLUTIONS.filter(r => r <= requestedRes).sort((a, b) => b - a);
    if (ladder.length === 0) ladder.push(requestedRes);

    let merged = new Map();
    let cellRes = ladder[0];
    let truncated = false;

    for (let i = 0; i < ladder.length; i++) {
      cellRes = ladder[i];
      const cellField = h3FieldName(cellRes);
      const batches = [];
      for (const query of queries) {
        const collection = this._requireCollection(query.dataCollection);
        const pipeline = buildSummaryPipeline({
          selector: query.dataSelector ?? {},
          groupProperty,
          cellField,
          timeProperty,
        });
        batches.push(await collection.aggregate(pipeline).toArray());
      }
      merged = mergeSummaries(batches);

      let total = 0;
      for (const facts of merged.values()) total += facts.cells.size;
      if (total <= maxCells) break;
      // Flagged even on the last rung, where no coarser stored field exists to
      // retry with: the client must know the footprint is incomplete either way.
      truncated = true;
      if (i === ladder.length - 1) break;
    }

    // Region documents: three rows, fetched once, never shipped — the polygons
    // are far too heavy for a field client.
    const regionDocs = [];
    if (opts.regions?.collection) {
      // Region tagging degrades, never fails. An unregistered collection, a
      // malformed selector, or an unreadable region collection leaves the
      // roster intact with no tags and `regionsAvailable: false` — a missing
      // region config must never blank the animal list. Only this block is
      // wrapped: a failure of the summary aggregation or the roster fetch is
      // still a failed request.
      try {
        const geometryProperty = opts.regions.geometryProperty ?? "bold:spatialDepiction";
        const collection = this._requireCollection(opts.regions.collection);
        const rows = await collection.find(opts.regions.selector ?? {}).toArray();
        for (const row of rows) {
          regionDocs.push({
            _id: row._id,
            label: row["rdfs:label"] ?? row["foaf:name"] ?? row._id,
            geometry: row[geometryProperty] ?? null,
          });
        }
      }
      catch (err) {
        regionDocs.length = 0;
        console.warn(
          `getGroupSummary: region tagging skipped — ${err?.message ?? err}`
        );
      }
    }

    const summary = {};
    let cellsAvailable = false;
    let timeAvailable = false;
    for (const [id, facts] of merged) {
      const cells = centroidsForCells(facts.cells);
      if (cells.length > 0) cellsAvailable = true;
      if (facts.firstMs !== null || facts.lastMs !== null) timeAvailable = true;
      summary[id] = {
        firstMs: facts.firstMs,
        lastMs:  facts.lastMs,
        count:   facts.count,
        cells,
        regions: regionDocs.length > 0 ? tagRegions(cells, regionDocs) : [],
      };
    }

    // The roster is defined by the data query, not by the resource collection:
    // a resource nothing points at is not part of this group set.
    const ids = [...merged.keys()];
    const resources = [];
    const seen = new Set();
    for (const query of queries) {
      if (ids.length === 0) break;
      const collection = this._requireCollection(query.resourceCollection);
      const projection = Array.isArray(opts.fields) && opts.fields.length > 0
        ? Object.fromEntries(opts.fields.map(f => [f, 1]))
        : undefined;
      const rows = await collection
        .find({ _id: { $in: ids } }, projection ? { projection } : {})
        .toArray();
      for (const row of rows) {
        if (seen.has(row._id)) continue;
        seen.add(row._id);
        resources.push(row);
      }
    }

    return {
      resources,
      summary,
      regions: regionDocs.map(({ _id, label }) => ({ _id, label })),
      meta: {
        cellProperty: h3FieldName(cellRes),
        cellRes,
        groupCount: merged.size,
        cellsAvailable,
        timeAvailable,
        regionsAvailable: regionDocs.some(r => r.geometry !== null),
        truncated,
      },
    };
  }

  /**
   * Compute a spatial range for each of a set of individuals and store it.
   *
   * The persistent counterpart of `RangeExtentPlugin`: where the plugin buckets
   * features by `groupProperty` to draw per-animal hulls live, this buckets
   * resources the same way and writes each hull to the individual it belongs to.
   * Individuals need not be animals — two queries and a link property describe
   * survey sites as readily as collared bobcats.
   *
   * The geo query is walked **once** and bucketed in memory, rather than queried
   * per individual: one round trip however many individuals there are. Only the
   * resolved shapes are retained, not the documents.
   *
   * Writes a plain `$set` of the Feature — no reasoning, no Statements. The
   * value is a datatype blob; HyLAR gains nothing from it, and `updateOne`'s
   * reasoning path would round-trip the geometry through SPARQL.
   *
   * See `.private/specs/ontologize/ontologize-geo-spec.md` § "Storing ranges".
   *
   * Writes go out in chunks of `WRITE_CHUNK` operations. A `bulkWrite` failure
   * partway through therefore throws *after* earlier chunks have already been
   * written — a throw here means partially written, not nothing written.
   *
   * @param {object} opts
   * @param {object|Query} opts.individuals - Query for the resources written onto
   * @param {object|Query} opts.geoData - Query for the resources hulled
   * @param {string} [opts.groupProperty="bold:animal"] - property on a geo
   *   resource naming its individual
   * @param {string} [opts.property="bold:spatialRange"] - where the Feature goes
   * @param {"convex"|"concave"} [opts.hullType] - forwarded to getSpatialRange
   * @param {number} [opts.alpha] - forwarded to getSpatialRange
   * @param {"cw"|"ccw"} [opts.winding] - forwarded to getSpatialRange
   * @param {object} [opts.properties] - merged into every Feature's properties
   * @param {boolean} [opts.clearEmpty=false] - $unset when no hull can be built
   * @param {boolean} [opts.dryRun=false] - compute everything, write nothing
   * @param {Map} [opts.ontologyCache] - shared across the whole run
   * @returns {Promise<object>} counts, `ranges`, and `skippedReasons`
   * @throws {Error} if either query names an unregistered collection, or if
   *   `hullType` or `winding` is not recognised — checked up front, before any
   *   collection is read, so a typo fails fast even when nothing would have
   *   matched
   */
  async updateSpatialRange(opts = {}) {
    const t0 = Date.now();
    const hullType = opts.hullType ?? "convex";
    const winding = opts.winding ?? "cw";

    // Validated here rather than left to getSpatialRange: that function only
    // sees a hullType/winding once a bucket has shapes to hull, so with 30k
    // geo docs a typo throws only after the whole resolve pass — or, if no
    // individual ends up with a bucket, never throws at all and the run
    // reports a clean "everything skipped" with a nonsense option. Same error
    // text as getSpatialRange's own check, so the message is identical
    // regardless of which path throws it.
    if (!HULL_TYPES.includes(hullType)) {
      throw new Error(`getSpatialRange: unknown hullType "${hullType}" — expected one of ${HULL_TYPES.join(", ")}`);
    }
    if (winding !== "cw" && winding !== "ccw") {
      throw new Error(`getSpatialRange: unknown winding "${winding}" — expected cw or ccw`);
    }

    const groupProperty = opts.groupProperty ?? "bold:animal";
    const property = opts.property ?? "bold:spatialRange";
    const clearEmpty = opts.clearEmpty === true;
    const dryRun = opts.dryRun === true;
    const ontologyCache = opts.ontologyCache ?? new Map();

    const individualsQuery = Query.from(opts.individuals);
    const geoQuery = Query.from(opts.geoData);
    const individualsCollection = this._requireCollection(individualsQuery.collection);
    const geoCollection = this._requireCollection(geoQuery.collection);

    const individuals = await individualsCollection
      .find(individualsQuery.selector, individualsQuery.opts).toArray();
    const byId = new Map(individuals.map(r => [r._id, r]));

    // One pass: resolve each doc's depiction, bucket the shape, drop the doc.
    const geoDocs = await geoCollection.find(geoQuery.selector, geoQuery.opts).toArray();
    const buckets = new Map();
    const unmatched = new Set();
    let geoUnresolved = 0;

    for (let i = 0; i < geoDocs.length; i++) {
      if (i > 0 && i % GeoApi.YIELD_EVERY === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      // Group keys are read before the shape is resolved, and before the
      // `!shape` bail below, so a doc naming an unmatched group still reaches
      // `unmatched` even when it also has no resolvable position — the
      // typo'd-partition-id case `unmatched` exists to surface is otherwise
      // invisible whenever those same docs lack coordinates too.
      const keys = groupKeysOf(geoDocs[i][groupProperty]);
      for (const key of keys) {
        if (!byId.has(key)) unmatched.add(key);
      }

      const shape = await this.getSpatialDepiction(geoDocs[i], { ontologyCache });
      if (!shape) {
        geoUnresolved++;
        continue;
      }
      for (const key of keys) {
        if (!byId.has(key)) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(shape);
      }
    }

    const ranges = [];
    const skippedReasons = {};
    const ops = [];

    for (const [id, individual] of byId) {
      const shapes = buckets.get(id);
      const feature = shapes ? getSpatialRange(shapes, {
        hullType,
        alpha: opts.alpha,
        winding,
        properties: {
          individualId: id,
          "rdfs:label": individual["rdfs:label"] ?? id,
          ...(opts.properties ?? {})
        }
      }) : null;

      if (!feature) {
        // Under clearEmpty these are the cleared ones; the key keeps its name
        // so a caller reads one place for "what got no range, and why".
        skippedReasons[id] = shapes
          ? `${new Set(shapes.flatMap(positionsOf).map(([lng, lat]) => `${lng},${lat}`)).size} distinct positions`
          : "no geo resources";
        if (clearEmpty) {
          ops.push({ updateOne: { filter: { _id: id }, update: { $unset: { [property]: "" } } } });
        }
        continue;
      }

      const diagnostics = feature.properties["bold:rangeDiagnostics"];
      ranges.push({
        id,
        areaKm2: diagnostics.areaKm2,
        vertices: diagnostics.vertices,
        positions: diagnostics.positions,
        distinctPositions: diagnostics.distinctPositions,
        // Repeated from the Feature so a caller can place every range on a map
        // from the result alone, without reopening the stored geometry.
        centroid: feature.properties.centroid.coordinates
      });
      ops.push({ updateOne: { filter: { _id: id }, update: { $set: { [property]: feature } } } });
    }

    if (!dryRun) {
      for (let i = 0; i < ops.length; i += GeoApi.WRITE_CHUNK) {
        await individualsCollection.bulkWrite(ops.slice(i, i + GeoApi.WRITE_CHUNK), { ordered: false });
      }
    }

    const empties = Object.keys(skippedReasons).length;
    return {
      individuals: byId.size,
      geoResources: geoDocs.length,
      geoUnresolved,
      updated: ranges.length,
      cleared: clearEmpty ? empties : 0,
      skipped: clearEmpty ? 0 : empties,
      unmatched: unmatched.size,
      durationMs: Date.now() - t0,
      ranges,
      skippedReasons
    };
  }

  /**
   * @deprecated Use {@link GeoApi#getSpatialDepiction}. Kept as a delegate so
   *   downstream consumers keep working; scheduled for removal once they migrate.
   *
   * @param {object} resource - The resource to get the depiction for
   * @param {object} [opts] - Options
   * @param {Map} [opts.ontologyCache] - Cache Map for ontology lookups
   * @returns {Promise<object|null>} See {@link GeoApi#getSpatialDepiction}
   */
  async getGeoJSON(resource, opts = {}) {
    return this.getSpatialDepiction(resource, opts);
  }

  /**
   * Extract a numeric value from a property value (handles JSON-LD @value wrapper)
   *
   * @param {*} value - The value to extract from
   * @returns {number|null} The numeric value or null
   * @private
   */
  _extractNumericValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "object" && value["@value"] !== undefined) {
      return parseFloat(value["@value"]);
    }
    if (typeof value === "string") {
      const num = parseFloat(value);
      return isNaN(num) ? null : num;
    }
    // Handle arrays - take first value
    if (Array.isArray(value) && value.length > 0) {
      return this._extractNumericValue(value[0]);
    }
    return null;
  }

  /**
   * Parse a property value as GeoJSON
   *
   * @param {*} value - The value to parse
   * @returns {object|null} GeoJSON object or null
   * @private
   */
  /**
   * Resolve one `bold:GeoJSON` property value, honouring `opts.depictionRole`.
   *
   * Falls straight through to `_parseGeoValue` when no role is asked for, so
   * every existing caller keeps its documented first-value behaviour — that
   * behaviour is depended on by `getSpatialDepiction`, `mergeShapes`,
   * `getSpatialRange`, `updateSpatialRange`, and the whole `gov.counties`
   * trimming design, and is not safe to change underneath them.
   *
   * With a role, it reaches through `resource.__raw` for the same reason
   * `mergeShapes`' `opts.select` hook does: an LD proxy collapses a
   * multi-valued property to its first value, so the proxy alone can never see
   * the second depiction.
   *
   * @param {string} propertyName
   * @param {*} propertyValue - the value as read off the (possibly proxied) resource
   * @param {object} resource
   * @param {object} opts - `depictionRole`, `strictRole`
   * @returns {object|null}
   * @private
   */
  _selectGeoValue(propertyName, propertyValue, resource, opts = {}) {
    if (!opts.depictionRole) return this._parseGeoValue(propertyValue);

    const raw = resource.__raw?.[propertyName] ?? propertyValue;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const picked = pickDepictionByRole(list, opts.depictionRole, { strict: opts.strictRole });
    return picked ? this._parseGeoValue(picked) : null;
  }

  _parseGeoValue(value) {
    if (!value) return null;

    // Handle arrays - take first value
    if (Array.isArray(value)) {
      return this._parseGeoValue(value[0]);
    }

    // Direct GeoJSON object (has type and coordinates/geometries/geometry)
    if (typeof value === "object" && value.type && (value.coordinates || value.geometries || value.geometry || value.features)) {
      return value;
    }

    // JSON-LD wrapped value
    if (typeof value === "object" && value["@value"] !== undefined) {
      const innerValue = value["@value"];
      if (typeof innerValue === "string") {
        try {
          return JSON.parse(innerValue);
        }
        catch (e) {
          return null;
        }
      }
      if (typeof innerValue === "object" && innerValue.type) {
        return innerValue;
      }
    }

    // String that might be JSON
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && parsed.type) {
          return parsed;
        }
      }
      catch (e) {
        return null;
      }
    }

    return null;
  }
}

// Convenience re-exports of the pure geo helpers (also available directly from
// the `ontologize/geo` subpath). These are instance-free and unrelated to the
// GeoApi instance methods above.
export * from "../geo/index.js";

export default GeoApi;
