/**
 * Per-skill deficiency counter — the heart of the event-driven trigger.
 *
 * The weekly time-throttle is replaced by accumulation: each time a user pushes
 * back on an org skill (detected by the FREE heuristic anchor on the local
 * transcript — no LLM), we increment that skill's count. When a skill crosses the
 * fire threshold (default 5, configurable), the worker fires for the whole org
 * cycle (detect org-wide → improve → publish) and that skill's count resets.
 *
 * This stays cheap and event-shaped: the increment is a pure state update driven
 * by a no-LLM signal, so it can run on every UserPromptSubmit / SessionEnd without
 * cost. Only the rare threshold-crossing spawns the (paid) worker.
 *
 * Invocations are deduped by a stable key (sessionId#index) so the same pushback
 * isn't counted twice when UserPromptSubmit fires repeatedly within one session.
 */

import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "./state-dir.js";

export const DEFAULT_FIRE_COUNT = 5;
/** Cap the dedup ledger so it can't grow unbounded across many sessions. */
const MAX_COUNTED = 2000;

export interface CounterState {
  /** "name--author" -> accumulated bad-count since the last fire. */
  counts?: Record<string, number>;
  /** invocation keys ("sessionId#index") already counted — dedup ledger (most-recent last). */
  counted?: string[];
  /** "name--author" -> ISO timestamp of the last fire (audit / re-fire visibility). */
  lastFired?: Record<string, string>;
}

/** One pushed-back org-skill invocation observed in a session. */
export interface AnchoredInvocation {
  skill: string;  // "name--author"
  key: string;    // stable dedup key, e.g. `${sessionId}#${index}`
}

export interface RecordResult {
  state: CounterState;
  /** skills that crossed the threshold this call → the worker should fire. */
  toFire: string[];
}

/**
 * Fold newly-observed anchored invocations into the counter. Pure: returns a new
 * state + the skills that just crossed `threshold`. Crossed skills reset to 0 and
 * stamp `lastFired` so they don't re-fire on the next increment.
 */
export function recordAnchored(
  prev: CounterState,
  observed: AnchoredInvocation[],
  nowIso: string,
  threshold: number = DEFAULT_FIRE_COUNT,
): RecordResult {
  const counts: Record<string, number> = { ...(prev.counts ?? {}) };
  const counted: string[] = [...(prev.counted ?? [])];
  const lastFired: Record<string, string> = { ...(prev.lastFired ?? {}) };
  const seen = new Set(counted);
  const toFire: string[] = [];

  for (const inv of observed) {
    if (!inv.skill || !inv.key) continue;
    if (seen.has(inv.key)) continue;        // already counted this invocation
    seen.add(inv.key);
    counted.push(inv.key);
    counts[inv.skill] = (counts[inv.skill] ?? 0) + 1;
    if (counts[inv.skill] >= threshold) {
      counts[inv.skill] = 0;                // reset so the next pushback starts a fresh tally
      lastFired[inv.skill] = nowIso;
      if (!toFire.includes(inv.skill)) toFire.push(inv.skill);
    }
  }

  // Prune the dedup ledger from the front (oldest) if it outgrows the cap.
  const pruned = counted.length > MAX_COUNTED ? counted.slice(counted.length - MAX_COUNTED) : counted;

  return { state: { counts, counted: pruned, lastFired }, toFire };
}

/** Env-tunable fire count: HIVEMIND_SKILLOPT_FIRE_COUNT (>0), else default 5. */
export function fireCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HIVEMIND_SKILLOPT_FIRE_COUNT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FIRE_COUNT;
}

/** Counter state lives under the HIVEMIND_STATE_DIR-aware skillopt/ subdir (computed
 *  lazily so a test/HOME swap takes effect; a subdir is skipped by skillify's top-level
 *  `.json` project enumeration). */
function counterFile(): string {
  return path.join(getStateDir(), "skillopt", "counter.json");
}

export function loadCounterState(file: string = counterFile()): CounterState {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as CounterState; } catch { return {}; }
}

export function saveCounterState(s: CounterState, file: string = counterFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic tmp+rename so a crash mid-write can't leave a torn JSON that resets the tally.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch { /* swallow — hooks must never fail */ }
}
