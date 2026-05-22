/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * https://www.gnu.org/licenses/lgpl-3.0.html.
 *
 * Entry point for the `ontologize/geo-server` sub-path export.
 *
 * Server-only geo helpers — currently `getDocsInCell` / `getDocsInCells`,
 * which talk to a Mongo collection resolved via the passed-in `ontologize`
 * instance's `.collections` registry. Don't import from client code.
 */

export * from "./cellFetcher.js";
export * from "./addH3.js";
