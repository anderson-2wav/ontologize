/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Base class for Ontologize API namespaces (e.g. `ontologize.display`,
 * `ontologize.schema`). A namespace groups a cohesive set of methods and
 * delegates shared state back to the owning Ontologize instance, so that
 * bodies can read `this.ld()` / `this.collections` / `this.opts` directly
 * rather than reaching through `this.ontologize.*` everywhere.
 *
 * Cross-namespace and core calls still go through the owning instance,
 * e.g. `this.ontologize.schema.getSchema(...)` or
 * `this.ontologize.getResourceForId(...)`.
 */
export class ApiNamespace {
  /**
   * @param {import("../Ontologize.js").Ontologize} ontologize - owning instance
   */
  constructor(ontologize) {
    this.ontologize = ontologize;
  }

  /**
   * The owning instance's singleton LD.
   * @returns {import("bold-ld").LD}
   * @throws {Error} If the context has not loaded yet — `await ready()` first
   */
  ld() {
    return this.ontologize.ld();
  }

  /**
   * The owning instance's registered collections.
   * @returns {Object.<string, object>}
   */
  get collections() {
    return this.ontologize.collections;
  }

  /**
   * The owning instance's options.
   * @returns {object}
   */
  get opts() {
    return this.ontologize.opts;
  }
}

export default ApiNamespace;
