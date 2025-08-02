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
   * @param {object} query - MongoDB-style query object
   * @param {object} [options] - Query options
   * @returns {Promise<Array>} Array of found documents
   */
  async find(query, options = {}) {
    try {
      // Meteor find returns a cursor, call fetch() to get array
      const cursor = this.collection.find(query, options);
      const result = cursor.fetch();
      return Promise.resolve(result || []);
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