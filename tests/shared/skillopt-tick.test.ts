import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEventTick, type TickDeps } from "../../src/skillify/skillopt-tick.js";
import { loadCounterState, saveCounterState, type CounterState } from "../../src/skillify/skillopt-counter.js";

const NOW = "2026-06-06T00:00:00Z";
function harness(over: Partial<TickDeps> = {}, initial: CounterState = {}) {
  let state = initial;
  const deps: TickDeps = {
    scan: async () => [],
    loadState: () => state,
    saveState: (s) => { state = s; },
    now: NOW,
    threshold: 5,
    ...over,
  };
  return { deps, get: () => state };
}

describe("runEventTick", () => {
  it("no anchored pushback → nothing recorded, nothing fires", async () => {
    const { deps, get } = harness({ scan: async () => [] });
    const r = await runEventTick("s1", deps);
    expect(r).toEqual({ observed: 0, toFire: [] });
    expect(get()).toEqual({}); // not even saved
  });

  it("records pushback and persists, but doesn't fire below threshold", async () => {
    const { deps, get } = harness({ scan: async () => [{ skill: "x--a", key: "s1#0" }] });
    const r = await runEventTick("s1", deps);
    expect(r.toFire).toEqual([]);
    expect(get().counts?.["x--a"]).toBe(1);
  });

  it("fires when accumulated pushback crosses the threshold across ticks", async () => {
    let st: CounterState = {};
    let last: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { deps } = harness({ scan: async () => [{ skill: "x--a", key: `s#${i}` }], loadState: () => st, saveState: (s) => { st = s; } });
      last = (await runEventTick("s1", deps)).toFire;
    }
    expect(last).toEqual(["x--a"]);     // crossed on the 5th distinct invocation
    expect(st.counts?.["x--a"]).toBe(0); // reset
  });

  it("empty session id is a no-op (doesn't scan)", async () => {
    const scan = vi.fn(async () => [{ skill: "x--a", key: "k" }]);
    const { deps } = harness({ scan });
    expect(await runEventTick("", deps)).toEqual({ observed: 0, toFire: [] });
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("counter persistence", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctr-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("round-trips state through disk and tolerates a missing/torn file", () => {
    const file = path.join(dir, "counter.json");
    expect(loadCounterState(file)).toEqual({});                  // missing → {}
    saveCounterState({ counts: { "x--a": 3 }, counted: ["k1"] }, file);
    expect(loadCounterState(file)).toEqual({ counts: { "x--a": 3 }, counted: ["k1"] });
    fs.writeFileSync(file, "{not json");
    expect(loadCounterState(file)).toEqual({});                  // torn → {} (no crash)
  });
});
