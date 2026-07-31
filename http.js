/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Root shim for the `ontologize/http` subpath.
 *
 * WHY THIS FILE EXISTS. `exports` in package.json already maps `./http` to
 * src/adapters/httpCollectionHandler.js, and that is enough for Node, for Vite,
 * and for any bundler that implements the `exports` field. It is not enough for
 * Meteor's *server* bundle, which resolves bare specifiers against the literal
 * file tree it copies into programs/server/npm/node_modules and does not read
 * `exports` at all. Without a real ./http.js on disk, `import ... from
 * "ontologize/http"` resolves in development — where node_modules/ontologize is
 * a symlink to this directory — and then fails at runtime on a built server
 * with "Cannot find module 'ontologize/http'".
 *
 * A re-export costs nothing and makes the subpath resolve the same way
 * everywhere, so the public specifier stays usable from a Meteor server, a
 * Nuxt/Nitro host, and plain Node alike. See http-collection-adapter-spec.md.
 *
 * Keep this in sync with the `./http` entry in package.json `exports`, and keep
 * "http.js" in package.json `files` so it survives packing.
 */

export { createCollectionHandler } from "./src/adapters/httpCollectionHandler.js";
