/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { ArchiveApi } from "../src/api/server/ArchiveApi.js";

/**
 * ArchiveApi only reads archivePath / mongoUrl / ontologyArchive off its owning
 * instance, so a plain object stands in for Ontologize here.
 */
function makeArchiveApi(ontologize = {}) {
  return new ArchiveApi({
    archivePath: "/srv/bold-assets/archives",
    mongoUrl: "mongodb://127.0.0.1:3201/meteor",
    ...ontologize
  });
}

describe("ArchiveApi.buildRestoreArgs", function() {
  it("builds the plain mongorestore args when no namespace mapping is given", function() {
    const args = makeArchiveApi().buildRestoreArgs({ archive: "track.all.archive" });

    assert.deepEqual(args, [
      "--drop",
      "--archive=/srv/bold-assets/archives/track.all.archive",
      "mongodb://127.0.0.1:3201/meteor"
    ]);
  });

  it("appends --nsFrom/--nsTo so an archive can be restored into a differently named database", function() {
    const args = makeArchiveApi().buildRestoreArgs({
      archive: "/tmp/track.all.archive",
      mongoUrl: "mongodb://127.0.0.1:27017/critter-track",
      nsFrom: "meteor.*",
      nsTo: "critter-track.*"
    });

    assert.deepEqual(args, [
      "--drop",
      "--archive=/tmp/track.all.archive",
      "--nsFrom=meteor.*",
      "--nsTo=critter-track.*",
      "mongodb://127.0.0.1:27017/critter-track"
    ]);
  });

  it("rejects nsTo without nsFrom, which would silently restore into the archive's own database", function() {
    assert.throws(
      () => makeArchiveApi().buildRestoreArgs({ archive: "track.all.archive", nsTo: "critter-track.*" }),
      /nsFrom.*nsTo/
    );
  });

  it("rejects nsFrom without nsTo", function() {
    assert.throws(
      () => makeArchiveApi().buildRestoreArgs({ archive: "track.all.archive", nsFrom: "meteor.*" }),
      /nsFrom.*nsTo/
    );
  });

  it("throws when no archive is given and none is configured", function() {
    assert.throws(() => makeArchiveApi().buildRestoreArgs({}), /archive/i);
  });

  it("falls back to the configured ontologyArchive", function() {
    const args = makeArchiveApi({ ontologyArchive: "ontology.archive" }).buildRestoreArgs({});

    assert.include(args, "--archive=/srv/bold-assets/archives/ontology.archive");
  });
});
