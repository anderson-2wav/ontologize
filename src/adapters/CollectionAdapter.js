/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
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
}