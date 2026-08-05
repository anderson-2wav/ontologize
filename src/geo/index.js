/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Entry point for the `ontologize/geo` sub-path export.
 *
 * Pure geo helpers — geohash and H3 utilities used by the GeoView /
 * ResourceGeoView cell-cache architecture. No Mongo, no Meteor, no node
 * built-ins; safe to import from client code.
 */

export * from "./geohash.js";
export * from "./h3.js";
export * from "./merge.js";
export * from "./range.js";
export * from "./pointInPolygon.js";
