/**
 * #4c — the event "tick": the cheap, no-LLM step that runs (detached) on
 * UserPromptSubmit / SessionEnd. It scans the just-active session for pushed-back
 * org skills (free anchor), folds them into the per-skill counter, and reports
 * which skills crossed the fire threshold. The caller (the worker) then runs the
 * paid org cycle ONLY when something fired — so the per-turn path stays free.
 *
 * This replaces the weekly time-throttle entirely: firing is driven by
 * accumulated real pushback, not the calendar.
 */
import { recordAnchored, type CounterState, type AnchoredInvocation } from "./skillopt-counter.js";

export interface TickDeps {
  /** Pushed-back org-skill invocations in this session (anchoredOrgSkillsInSession, bound). */
  scan: (sessionId: string) => Promise<AnchoredInvocation[]>;
  loadState: () => CounterState;
  saveState: (s: CounterState) => void;
  now: string;       // injected ISO
  threshold: number; // fire count (default 5)
}

export interface TickResult {
  observed: number;      // anchored invocations seen this tick
  toFire: string[];      // skills that crossed the threshold → run the cycle
}

/** Scan → record → persist → report skills to fire. No worker spawn here (caller decides). */
export async function runEventTick(sessionId: string, deps: TickDeps): Promise<TickResult> {
  if (!sessionId) return { observed: 0, toFire: [] };
  const observed = await deps.scan(sessionId);
  if (observed.length === 0) return { observed: 0, toFire: [] };
  const { state, toFire } = recordAnchored(deps.loadState(), observed, deps.now, deps.threshold);
  deps.saveState(state);
  return { observed: observed.length, toFire };
}
