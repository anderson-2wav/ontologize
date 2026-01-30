/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 2wav, Inc.
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
