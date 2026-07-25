/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Abstract base class for collection adapters
 * Provides a consistent async interface for different collection types
 */
export class CollectionAdapter {
  constructor(collection, name) {
    this.collection = collection;
    this.name = name;
  }

  /**
   * Find one document matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<object|null>} The found document or null
   */
  async findOne(query, options = {}) {
    throw new Error("findOne must be implemented by subclass");
  }

  /**
   * Find multiple documents matching the query
   * @param {object} query - MongoDB-style query object  
   * @param {object} [options] - Query options
   * @returns {Promise<Array>} Array of found documents
   */
  async find(query, options = {}) {
    throw new Error("find must be implemented by subclass");
  }

  /**
   * Count documents matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<number>} Count of matching documents
   */
  async count(query, options = {}) {
    throw new Error("count must be implemented by subclass");
  }

  /**
   * Count documents matching the query (MongoDB driver API)
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<number>} Count of matching documents
   */
  async countDocuments(query, options = {}) {
    throw new Error("countDocuments must be implemented by subclass");
  }

  /**
   * Delete many documents matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Delete options
   * @returns {Promise<object>} Result with deletedCount
   */
  async deleteMany(query, options = {}) {
    throw new Error("deleteMany must be implemented by subclass");
  }

  // NOTE: `bulkWrite(operations, options)` is deliberately NOT declared here.
  // It is an optional capability — callers (e.g. the reasoner's statement
  // upserts) feature-detect with `typeof collection.bulkWrite === "function"`
  // and fall back to one write per document. Declaring a throwing stub on the
  // base would make every adapter claim support and break that detection.
}