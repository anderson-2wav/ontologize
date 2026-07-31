/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 *
 * Tests for src/lib/reasonRunState.js — the single-flight + pending-queue
 * state machine behind background reasoning.
 *
 * Run: meteor npm run test-ontologize
 */

import { assert } from "chai";
import { createRunState } from "../src/lib/reasonRunState.js";

const P2025 = "track:track-2025";
const LEGACY = "track:track-legacy";

describe("reasonRunState", function () {

  describe("single-flight", function () {

    it("starts idle", function () {
      const s = createRunState();
      assert.isFalse(s.snapshot().running);
      assert.isNull(s.snapshot().lastRun);
      assert.isFalse(s.snapshot().pending);
    });

    it("grants the first claim and refuses the second", function () {
      const s = createRunState();
      assert.isTrue(s.begin(P2025));
      assert.isFalse(s.begin(P2025));
    });

    it("reports the running scope and start time", function () {
      const s = createRunState({ now: () => 1_000_000 });
      s.begin(LEGACY);
      const snap = s.snapshot();
      assert.isTrue(snap.running);
      assert.equal(snap.scope, LEGACY);
      assert.equal(snap.startedAt, new Date(1_000_000).toISOString());
    });

    it("can be claimed again after end()", function () {
      const s = createRunState();
      s.begin();
      s.end();
      assert.isFalse(s.snapshot().running);
      assert.isTrue(s.begin());
    });

    it("reports no scope or start time once idle", function () {
      const s = createRunState();
      s.begin(P2025);
      s.end();
      assert.isNull(s.snapshot().scope);
      assert.isNull(s.snapshot().startedAt);
    });
  });

  describe("queueing", function () {

    it("queues a refused request rather than dropping it", function () {
      // The whole point: a running pass has already made its selection, so
      // documents written since would otherwise never be reasoned.
      const s = createRunState();
      s.begin(P2025);
      s.begin(LEGACY);
      assert.isTrue(s.snapshot().pending);
      assert.deepEqual(s.takePending(), { scope: LEGACY });
    });

    it("returns null when nothing is queued", function () {
      const s = createRunState();
      s.begin(P2025);
      assert.isNull(s.takePending());
    });

    it("clears the queue once taken", function () {
      const s = createRunState();
      s.begin(P2025);
      s.begin(LEGACY);
      s.takePending();
      assert.isNull(s.takePending());
      assert.isFalse(s.snapshot().pending);
    });

    it("collapses a repeated request for the same partition", function () {
      const s = createRunState();
      s.begin(P2025);
      s.begin(LEGACY);
      s.begin(LEGACY);
      assert.deepEqual(s.takePending(), { scope: LEGACY });
    });

    it("widens to unscoped when two different partitions are queued", function () {
      // One unscoped pass is no more work than two scoped ones, because
      // onlyUnReasoned already narrows it — and it keeps scope a single value.
      const s = createRunState();
      s.begin(P2025);
      s.begin(LEGACY);
      s.begin("track:track-2026");
      assert.deepEqual(s.takePending(), { scope: undefined });
    });

    it("lets an unscoped request supersede queued partitions", function () {
      const s = createRunState();
      s.begin(P2025);
      s.begin(LEGACY);
      s.begin(undefined);
      assert.deepEqual(s.takePending(), { scope: undefined });
    });

    it("keeps an unscoped request unscoped when a partition follows it", function () {
      // Reasoning everything already covers the partition.
      const s = createRunState();
      s.begin(P2025);
      s.begin(undefined);
      s.begin(LEGACY);
      assert.deepEqual(s.takePending(), { scope: undefined });
    });
  });

  describe("run records", function () {

    it("records a completed pass without releasing the runner", function () {
      const s = createRunState({ now: () => 5_000 });
      s.begin(P2025);
      s.recordRun({ scope: P2025, resources: 4982, statements: 54802, durationMs: 155000 });

      const snap = s.snapshot();
      assert.isTrue(snap.running, "still running — the loop may go again");
      assert.equal(snap.lastRun.passes, 1);
      assert.equal(snap.lastRun.resources, 4982);
      assert.equal(snap.lastRun.statements, 54802);
      assert.deepEqual(snap.lastRun.scopes, [P2025]);
      assert.isNull(snap.lastRun.error);
      assert.equal(snap.lastRun.finishedAt, new Date(5_000).toISOString());
    });

    it("accumulates across the passes of one cycle", function () {
      // A cycle that reasons 300 documents and then runs a queued second pass
      // finding nothing must not report "0 resources" as its result.
      const s = createRunState();
      s.begin(LEGACY);
      s.recordRun({ scope: LEGACY, resources: 300, statements: 5100, facts: 900, durationMs: 9000 });
      s.recordRun({ scope: P2025, resources: 0, statements: 0, facts: 0, durationMs: 400 });

      const { lastRun } = s.snapshot();
      assert.equal(lastRun.passes, 2);
      assert.equal(lastRun.resources, 300);
      assert.equal(lastRun.statements, 5100);
      assert.equal(lastRun.facts, 900);
      assert.equal(lastRun.durationMs, 9400);
      assert.deepEqual(lastRun.scopes, [LEGACY, P2025]);
    });

    it("does not repeat a scope covered twice in one cycle", function () {
      const s = createRunState();
      s.begin(LEGACY);
      s.recordRun({ scope: LEGACY, resources: 2 });
      s.recordRun({ scope: LEGACY, resources: 3 });
      assert.deepEqual(s.snapshot().lastRun.scopes, [LEGACY]);
      assert.equal(s.snapshot().lastRun.resources, 5);
    });

    it("records an unscoped pass as a null scope", function () {
      const s = createRunState();
      s.begin();
      s.recordRun({ scope: null, resources: 7 });
      assert.deepEqual(s.snapshot().lastRun.scopes, [null]);
    });

    it("clears a stale lastRun when a new pass begins", function () {
      const s = createRunState();
      s.begin();
      s.recordRun({ resources: 1 });
      s.end();
      s.begin();
      assert.isNull(s.snapshot().lastRun, "an old result must not read as this run's");
    });
  });

  describe("failure", function () {

    it("records the message and releases the runner", function () {
      // A detached run that fails invisibly is the whole hazard of
      // backgrounding this, so the message has to survive somewhere.
      const s = createRunState();
      s.begin(LEGACY);
      s.fail(new Error("HyLAR is not answering"));

      const snap = s.snapshot();
      assert.isFalse(snap.running);
      assert.equal(snap.lastRun.error, "HyLAR is not answering");
      assert.equal(snap.lastRun.scope, LEGACY);
    });

    it("accepts a non-Error", function () {
      const s = createRunState();
      s.begin();
      s.fail("plain string");
      assert.equal(s.snapshot().lastRun.error, "plain string");
    });

    it("drops queued work rather than retrying into the same failure", function () {
      // Whatever killed the pass — a reasoner that is down, most likely —
      // would kill the retry too, and a self-retrying loop against a dead
      // HyLAR is worse than a stopped one. bold:reasoned means the next
      // deliberate request resumes from exactly here.
      const s = createRunState();
      s.begin(P2025);
      s.begin(LEGACY);
      s.fail(new Error("boom"));
      assert.isFalse(s.snapshot().pending);
      assert.isNull(s.takePending());
    });

    it("can be claimed again after a failure", function () {
      const s = createRunState();
      s.begin();
      s.fail(new Error("boom"));
      assert.isTrue(s.begin());
    });
  });

  describe("the loop it drives", function () {

    it("runs exactly once more for work queued mid-pass", function () {
      // This is the sequence reason.js executes; asserting it here is what
      // makes the wiring there trivial enough to read.
      const s = createRunState();
      const passes = [];

      assert.isTrue(s.begin(P2025));
      let scope = P2025;

      for (let guard = 0; guard < 10; guard++) {
        if (guard === 0) s.begin(LEGACY);        // an import lands mid-pass
        passes.push(scope);
        s.recordRun({ scope, resources: 1 });
        const pending = s.takePending();
        if (!pending) break;
        scope = pending.scope;
      }
      s.end();

      assert.deepEqual(passes, [P2025, LEGACY]);
      assert.isFalse(s.snapshot().running);
    });

    it("terminates when nothing more is queued", function () {
      const s = createRunState();
      s.begin();
      let passes = 0;
      for (let guard = 0; guard < 10; guard++) {
        passes++;
        s.recordRun({ resources: 0 });
        if (!s.takePending()) break;
      }
      s.end();
      assert.equal(passes, 1);
    });
  });
});
