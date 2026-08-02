/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

/**
 * Run-state for background reasoning: single-flight, plus a pending queue.
 *
 * Pure and dependency-free — this is the part of the runner with branching
 * logic in it; the wiring in ReasonerApi is not.
 *
 * WHY A GUARD AT ALL. `reasonCollection` selects documents lacking
 * `bold:reasoned` and marks them as it goes, so two concurrent runs would both
 * select the same unreasoned batch and both write statements for it.
 *
 * WHY A PENDING QUEUE RATHER THAN A REFUSAL. A run that is already in flight
 * has already made its selection, so documents written by an import that lands
 * mid-run would be missed and stay unreasoned indefinitely. Refusing the second
 * request would be silently wrong. Instead the request is remembered and the
 * runner loops once more when the current pass finishes.
 *
 * Scope is a partition string (`track:track-2025`) or `undefined` meaning
 * everything. Pending scopes merge: an unscoped request supersedes any queued
 * partitions, because reasoning everything covers them all.
 */

/**
 * @returns {{
 *   begin: (scope?: string) => boolean,
 *   recordRun: (run: object) => void,
 *   takePending: () => {scope: string|undefined}|null,
 *   end: () => void,
 *   fail: (error: Error) => void,
 *   snapshot: () => object
 * }}
 */
export function createRunState({ now = () => Date.now() } = {}) {
  let running = false;
  let scope;               // scope of the run in flight
  let startedMs = null;
  let lastRun = null;      // the most recent completed pass, success or failure

  let pendingAll = false;          // an unscoped request is queued
  const pendingScopes = new Set(); // partition-scoped requests queued

  function hasPending() {
    return pendingAll || pendingScopes.size > 0;
  }

  function queue(requestedScope) {
    if (requestedScope === undefined) {
      // Unscoped covers every partition, so the specific queue is redundant.
      pendingAll = true;
      pendingScopes.clear();
    }
    else if (!pendingAll) {
      pendingScopes.add(requestedScope);
    }
  }

  return {
    /**
     * Claim the runner. Returns false when a pass is already in flight, in
     * which case the request has been queued instead of dropped.
     */
    begin(requestedScope) {
      if (running) {
        queue(requestedScope);
        return false;
      }
      running = true;
      scope = requestedScope;
      startedMs = now();
      lastRun = null;
      return true;
    },

    /**
     * Record a completed pass without releasing the runner.
     *
     * Accumulates across the passes of one begin()..end() cycle rather than
     * overwriting. A cycle that reasons 300 documents and then runs a queued
     * second pass finding nothing would otherwise report "0 resources" as its
     * result — technically the last pass, but a plain misreading of what just
     * happened for anyone watching.
     */
    recordRun(run) {
      const prev = lastRun && !lastRun.error ? lastRun : null;
      const scopes = prev ? prev.scopes.slice() : [];
      if (!scopes.includes(run.scope ?? null)) scopes.push(run.scope ?? null);

      // Stage timings accumulate key-wise for the same reason the scalars do:
      // the cycle's profile is the sum of its passes, not the last one's.
      // Union of keys, so a pass that skipped a stage does not drop it.
      const stageMs = { ...(prev ? prev.stageMs : null) };
      for (const [stage, ms] of Object.entries(run.stageMs || {})) {
        stageMs[stage] = (stageMs[stage] || 0) + (ms || 0);
      }

      lastRun = {
        passes: (prev ? prev.passes : 0) + 1,
        scopes,
        resources: (prev ? prev.resources : 0) + (run.resources || 0),
        statements: (prev ? prev.statements : 0) + (run.statements || 0),
        facts: (prev ? prev.facts : 0) + (run.facts || 0),
        durationMs: (prev ? prev.durationMs : 0) + (run.durationMs || 0),
        stageMs,
        finishedAt: new Date(now()).toISOString(),
        error: null,
      };
    },

    /**
     * Take the queued work, if any, so the runner can loop.
     * @returns {{scope: string|undefined}|null} null when nothing is queued
     */
    takePending() {
      if (!hasPending()) return null;

      if (pendingAll) {
        pendingAll = false;
        pendingScopes.clear();
        return { scope: undefined };
      }

      // More than one partition queued: fall back to an unscoped pass rather
      // than looping per partition. `onlyUnReasoned` makes that no more work,
      // and it keeps the scope a single value.
      const scopes = Array.from(pendingScopes);
      pendingScopes.clear();
      return { scope: scopes.length === 1 ? scopes[0] : undefined };
    },

    /** Release the runner after a clean finish. */
    end() {
      running = false;
      scope = undefined;
      startedMs = null;
    },

    /**
     * Release the runner after a failure, recording it so a detached run
     * cannot fail invisibly — the whole hazard of backgrounding this.
     */
    fail(error) {
      lastRun = {
        finishedAt: new Date(now()).toISOString(),
        scope,
        error: error && error.message ? error.message : String(error),
      };
      running = false;
      scope = undefined;
      startedMs = null;
      // Queued work is dropped: whatever made the pass fail (a reasoner that is
      // down, most likely) would fail the retry too, and a self-retrying loop
      // against a dead HyLAR is worse than a stopped one. `bold:reasoned` means
      // the next deliberate request resumes exactly where this left off.
      pendingAll = false;
      pendingScopes.clear();
    },

    /** Everything the status endpoint reports that is not counted from the data. */
    snapshot() {
      return {
        running,
        scope: running ? scope || null : null,
        startedAt: startedMs === null ? null : new Date(startedMs).toISOString(),
        pending: hasPending(),
        lastRun,
      };
    },
  };
}
