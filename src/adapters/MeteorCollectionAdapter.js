/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
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
    } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
      throw new Error(`Error in ${this.name}.count: ${error.message}`);
    }
  }
}