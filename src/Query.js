/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { check, Match } from "./lib/check.js";

/**
 * Query - A standard query specifier for Ontologize collections.
 *
 * Represents a named MongoDB query against a registered Ontologize collection.
 * Instances validate on construction and serialize cleanly to/from JSON,
 * making them safe to pass over DDP, store in MongoDB, or use in UI code.
 *
 * @class
 */
export class Query {
  static TYPE = "ontologize:Query";

  /**
   * Create a new Query instance.
   *
   * @param {object} spec - Query specification
   * @param {string} spec.name - Readable name for this query (used in UI)
   * @param {string} spec.collection - Registered name of the Ontologize collection
   * @param {object} [spec.selector={}] - MongoDB query selector
   * @param {object} [spec.opts={}] - Query options (sort, limit, projection, etc.)
   * @param {number} [count] = sometimes useful to indicate how many found
   * @throws {Error} If name or collection are not strings
   */
  constructor({ name, collection, selector = {}, opts = {}, count }) {
    check(name, String, "Query requires a string 'name'");
    check(collection, String, "Query requires a string 'collection'");
    check(selector, Object, "Query 'selector' must be an object");
    check(opts, Object, "Query 'opts' must be an object");
    check(count, Match.Optional(Number), "Query 'count' must be a number");
    this.name = name;
    this.collection = collection;
    this.selector = selector;
    this.opts = opts;
    if (typeof count === "number") {
      this.count = count;
    }
  }

  /**
   * Create a Query from a plain object or return an existing Query instance.
   *
   * Use at module boundaries where queries may arrive as plain objects
   * (e.g., from Meteor methods, DDP, or JSON storage).
   *
   * @param {object|Query} obj - A plain object or Query instance
   * @returns {Query} A Query instance
   */
  static from(obj) {
    if (obj instanceof Query) return obj;
    return new Query(obj);
  }

  /**
   * JSON serialization. Includes @type discriminator for identification
   * in mixed data structures.
   *
   * @returns {object} Plain object representation with @type
   */
  toJSON() {
    return {
      "@type": Query.TYPE,
      name: this.name,
      collection: this.collection,
      selector: this.selector,
      opts: this.opts,
      count: this.count
    };
  }
}
