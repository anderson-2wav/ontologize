/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { CollectionAdapter } from "./CollectionAdapter.js";

/**
 * Meteor Collection Adapter
 * Wraps Meteor collections to provide consistent async interface
 * Works on both client (with subscriptions) and server
 */
export class MeteorCollectionAdapter extends CollectionAdapter {
  /**
   * Create a Meteor collection adapter
   * @param {object} meteorCollection - Meteor collection instance
   * @param {string} name - Collection name for debugging
   */
  constructor(meteorCollection, name) {
    super(meteorCollection, name);
  }

  /**
   * Find one document matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<object|null>} The found document or null
   */
  async findOne(query, options = {}) {
    try {
      // Meteor collections have sync methods, wrap in Promise for consistency
      const result = this.collection.findOne(query, options);
      return Promise.resolve(result || null);
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.findOne: ${error.message}`);
    }
  }

  /**
   * Find multiple documents matching the query
   * Returns a cursor-like object compatible with MongoDB driver API
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {object} Cursor-like object with toArray() method
   */
  find(query, options = {}) {
    try {
      // Meteor find returns a cursor with fetch()
      // Wrap it to also provide toArray() for MongoDB driver compatibility
      const meteorCursor = this.collection.find(query, options);

      return {
        // MongoDB driver API
        toArray: async () => {
          return Promise.resolve(meteorCursor.fetch() || []);
        },
        // Meteor API (passthrough)
        fetch: () => meteorCursor.fetch(),
        count: () => meteorCursor.count(),
        // Add other cursor methods as needed
        forEach: (fn) => meteorCursor.forEach(fn),
        map: (fn) => meteorCursor.map(fn)
      };
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.find: ${error.message}`);
    }
  }

  /**
   * Count documents matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<number>} Count of matching documents
   */
  async count(query, options = {}) {
    try {
      const cursor = this.collection.find(query, options);
      const result = cursor.count();
      return Promise.resolve(result || 0);
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.count: ${error.message}`);
    }
  }

  /**
   * Count documents matching the query (MongoDB driver API)
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<number>} Count of matching documents
   */
  async countDocuments(query = {}, options = {}) {
    try {
      // Prefer native countDocuments (available on rawCollection)
      if (typeof this.collection.countDocuments === "function") {
        return await this.collection.countDocuments(query, options);
      }
      // Fallback to find().count() for Meteor collections
      const cursor = this.collection.find(query, options);
      const result = cursor.count();
      return Promise.resolve(result || 0);
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.countDocuments: ${error.message}`);
    }
  }

  /**
   * Insert multiple documents
   * @param {Array<object>} docs - Documents to insert
   * @param {object} [options] - Insert options
   * @returns {Promise<object>} Result with insertedCount and insertedIds
   */
  async insertMany(docs, options = {}) {
    try {
      const result = await this.collection.insertMany(docs, options);
      return result;
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.insertMany: ${error.message}`);
    }
  }

  /**
   * Insert one document
   * @param {object} doc - Document to insert
   * @param {object} [options] - Insert options
   * @returns {Promise<object>} Result with insertedId
   */
  async insertOne(doc, options = {}) {
    try {
      const result = await this.collection.insertOne(doc, options);
      return result;
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.insertOne: ${error.message}`);
    }
  }

  /**
   * Replace one document matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} replacement - Replacement document
   * @param {object} [options] - Replace options (e.g., { upsert: true })
   * @returns {Promise<object>} Result with modifiedCount
   */
  async replaceOne(query, replacement, options = {}) {
    try {
      const result = await this.collection.replaceOne(query, replacement, options);
      return result;
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.replaceOne: ${error.message}`);
    }
  }

  /**
   * Update one document matching the query.
   *
   * Prefers the MongoDB driver's `updateOne` and falls back to Meteor's
   * `updateAsync` / `upsertAsync`, because a `Mongo.Collection` has neither of
   * the driver's names — only `update`/`upsert` and their async forms. Without
   * the fallback every write method here is a `rawCollection()`-only path,
   * despite this adapter existing to serve the client.
   *
   * Meteor resolves to a *count* rather than a result object, so the driver's
   * shape is reconstructed for callers that read `modifiedCount`.
   *
   * On the `updateAsync` fallback path, that count is *documents affected*,
   * not documents changed: `modifiedCount` is set equal to `matchedCount` and
   * will read 1 for a no-op `$set` where the driver's own `updateOne` would
   * report 0. A caller summing `modifiedCount` across calls as "documents
   * changed" over this path over-counts.
   *
   * @param {object} query - MongoDB-style query object
   * @param {object} update - Update operations (e.g., { $set: { field: value } })
   * @param {object} [options] - Update options (e.g., { upsert: true })
   * @returns {Promise<object>} Result with matchedCount, modifiedCount, upsertedCount
   */
  async updateOne(query, update, options = {}) {
    try {
      if (typeof this.collection.updateOne === "function") {
        return await this.collection.updateOne(query, update, options);
      }

      if (options.upsert && typeof this.collection.upsertAsync === "function") {
        const result = await this.collection.upsertAsync(query, update, options) ?? {};
        const inserted = result.insertedId ?? null;
        const affected = result.numberAffected ?? 0;
        return {
          acknowledged: true,
          matchedCount: inserted ? 0 : affected,
          modifiedCount: inserted ? 0 : affected,
          upsertedCount: inserted ? 1 : 0,
          upsertedId: inserted
        };
      }

      const modifiedCount = await this.collection.updateAsync(query, update, options);
      return {
        acknowledged: true,
        matchedCount: modifiedCount,
        modifiedCount,
        upsertedCount: 0,
        upsertedId: null
      };
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.updateOne: ${error.message}`);
    }
  }

  /**
   * Execute a batch of write operations.
   *
   * Passed straight through when the wrapped collection is a raw MongoDB driver
   * collection (Meteor's `rawCollection()`), which is the case that matters for
   * throughput. A Meteor collection has no bulkWrite, so `updateOne` operations
   * are replayed one at a time — same semantics, more round trips. Anything else
   * throws rather than silently skipping writes.
   *
   * @param {Array<object>} operations - MongoDB bulkWrite operations
   * @param {object} [options] - bulkWrite options (e.g., { ordered: false })
   * @returns {Promise<object>} Result with upsertedCount, modifiedCount, matchedCount
   */
  async bulkWrite(operations, options = {}) {
    try {
      if (typeof this.collection.bulkWrite === "function") {
        return await this.collection.bulkWrite(operations, options);
      }

      let upsertedCount = 0;
      let modifiedCount = 0;
      let matchedCount = 0;
      for (const op of operations) {
        if (!op.updateOne) {
          throw new Error(`unsupported operation ${Object.keys(op).join(",")} (only updateOne is emulated)`);
        }
        const { filter, update, upsert } = op.updateOne;
        const result = await this.updateOne(filter, update, { upsert });
        upsertedCount += result.upsertedCount || 0;
        modifiedCount += result.modifiedCount || 0;
        matchedCount += result.matchedCount || 0;
      }
      return { upsertedCount, modifiedCount, matchedCount };
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.bulkWrite: ${error.message}`);
    }
  }

  /**
   * Delete many documents matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Delete options
   * @returns {Promise<object>} Result with deletedCount
   */
  async deleteMany(query, options = {}) {
    try {
      const result = await this.collection.deleteMany(query, options);
      return result;
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.deleteMany: ${error.message}`);
    }
  }
}
