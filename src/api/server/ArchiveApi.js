/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { spawn } from "child_process";
import path from "path";
import * as fs from "node:fs";
import { ApiNamespace } from "../ApiNamespace.js";

/**
 * `ontologizeServer.archive` — mongodump / mongorestore of the database to and
 * from archive files. Pure Node.js (no Meteor). Reads archive path / mongo URL
 * config from the owning instance (this.ontologize.archivePath, .mongoUrl,
 * .ontologyArchive).
 */
export class ArchiveApi extends ApiNamespace {
  /**
   * The mongorestore argv for a restore. Split out from restoreFromArchive so
   * the path / namespace resolution is testable without spawning mongorestore.
   *
   * An archive carries the namespaces it was dumped from, so the database in
   * the connection URL does not redirect it: restoring a `meteor.*` archive
   * into a database named something else needs --nsFrom/--nsTo.
   *
   * @param {object} [opts] - See restoreFromArchive
   * @returns {string[]} mongorestore arguments
   */
  buildRestoreArgs(opts = {}) {
    const archive = opts.archive || this.ontologize.ontologyArchive;
    if (!archive) {
      throw new Error("No restore archive configured. Pass opts.archive or set opts.ontologyArchive in constructor.");
    }

    // mongorestore ignores a lone --nsTo, which would quietly restore into the
    // archive's own database instead of the intended one.
    if (Boolean(opts.nsFrom) !== Boolean(opts.nsTo)) {
      throw new Error("opts.nsFrom and opts.nsTo must be given together, e.g. nsFrom: \"meteor.*\", nsTo: \"critter-track.*\"");
    }

    const archivePath = path.isAbsolute(archive)
      ? archive
      : path.join(opts.archivePath || this.ontologize.archivePath, archive);

    const mongoUrl = opts.mongoUrl || this.ontologize.mongoUrl;

    return [
      "--drop",
      `--archive=${archivePath}`,
      ...(opts.nsFrom ? [`--nsFrom=${opts.nsFrom}`, `--nsTo=${opts.nsTo}`] : []),
      mongoUrl
    ];
  }

  /**
   * Restore a MongoDB collection from a mongorestore archive file.
   * Pure Node.js — no Meteor dependency.
   *
   * @param {object} [opts]
   * @param {string} [opts.archive] - Archive filename or absolute path (defaults to this.ontologize.ontologyArchive)
   * @param {string} [opts.archivePath] - Base path for relative archive filenames (defaults to this.ontologize.archivePath)
   * @param {string} [opts.mongoUrl] - MongoDB connection URL (defaults to this.ontologize.mongoUrl)
   * @param {string} [opts.nsFrom] - Source namespace pattern, e.g. "meteor.*". Must be paired with nsTo
   * @param {string} [opts.nsTo] - Target namespace pattern, e.g. "critter-track.*"
   * @returns {Promise<object>} { success, message }
   */
  async restoreFromArchive(opts = {}) {
    const args = this.buildRestoreArgs(opts);

    console.log(`restoreFromArchive: mongorestore ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      const proc = spawn("mongorestore", args);
      let stderr = "";

      proc.stdout.on("data", (data) => console.log("mongorestore stdout:", data.toString()));
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
        console.log("mongorestore stderr:", data.toString());
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true, message: `mongorestore finished (exit ${code})` });
        }
        else {
          reject(new Error(`mongorestore exit code ${code}: ${stderr}`));
        }
      });
      proc.on("error", (err) => {
        reject(new Error(`mongorestore spawn failed: ${err.message}`));
      });
    });
  }

  /**
   * Dump the MongoDB database to a mongorestore-compatible archive file.
   * The mirror of restoreFromArchive — same path/URL resolution, same spawn
   * shape, no gzip so the result can be fed straight back to
   * restoreFromArchive. Pure Node.js — no Meteor dependency.
   *
   * The dump is written to `<archive>.tmp` and renamed on success, so a crashed
   * or killed mongodump never leaves a truncated file that later looks like the
   * most recent good backup.
   *
   * @param {object} opts
   * @param {string} opts.archive - Archive filename or absolute path
   * @param {string} [opts.archivePath] - Base path for relative archive filenames (defaults to this.ontologize.archivePath)
   * @param {string} [opts.mongoUrl] - MongoDB connection URL (defaults to this.ontologize.mongoUrl)
   * @returns {Promise<object>} { success, message, archivePath, bytes }
   */
  async dumpToArchive(opts = {}) {
    const archive = opts.archive;
    if (!archive) {
      throw new Error("No dump archive specified. Pass opts.archive.");
    }

    const archivePath = path.isAbsolute(archive)
      ? archive
      : path.join(opts.archivePath || this.ontologize.archivePath, archive);
    const tmpPath = `${archivePath}.tmp`;

    const mongoUrl = opts.mongoUrl || this.ontologize.mongoUrl;

    console.log(`dumpToArchive: mongodump --archive=${archivePath} ${mongoUrl}`);

    await new Promise((resolve, reject) => {
      const args = [`--archive=${tmpPath}`, mongoUrl];
      const proc = spawn("mongodump", args);
      let stderr = "";

      // mongodump writes its progress to stderr even on success, so stderr is
      // only reported when the exit code says the dump actually failed.
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        }
        else {
          reject(new Error(`mongodump exit code ${code}: ${stderr}`));
        }
      });
      proc.on("error", (err) => {
        reject(new Error(`mongodump spawn failed: ${err.message}`));
      });
    }).catch(async (err) => {
      await fs.promises.rm(tmpPath, { force: true });
      throw err;
    });

    await fs.promises.rename(tmpPath, archivePath);
    const { size } = await fs.promises.stat(archivePath);

    return {
      success: true,
      message: `mongodump finished (${size} bytes)`,
      archivePath,
      bytes: size,
    };
  }
}

export default ArchiveApi;
