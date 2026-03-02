/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
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
   * Update one document matching the query
   * @param {object} query - MongoDB-style query object
   * @param {object} update - Update operations (e.g., { $set: { field: value } })
   * @param {object} [options] - Update options (e.g., { upsert: true })
   * @returns {Promise<object>} Result with modifiedCount
   */
  async updateOne(query, update, options = {}) {
    try {
      const result = await this.collection.updateOne(query, update, options);
      return result;
    }
    catch (error) {
      throw new Error(`Error in ${this.name}.updateOne: ${error.message}`);
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
