/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { README } from "../readme.js";

describe("ontologize/readme", function() {
  it("should export README as a string", function() {
    assert.isString(README);
  });

  it("should contain the module title", function() {
    assert.include(README, "# Ontologize");
  });

  it("should contain license information", function() {
    assert.include(README, "Mozilla Public License 2.0");
  });

  it("should contain BOLD stack reference", function() {
    assert.include(README, "BOLD");
  });

  it("should mention TBox/ABox", function() {
    assert.include(README, "TBox");
    assert.include(README, "ABox");
  });

  it("should have substantial content", function() {
    assert.isAbove(README.length, 500, "README should have substantial content");
  });
});
