/**
 * Unit tests for src/skillify/advisor.ts — the sonnet-based ranking
 * pass that picks the best insight-bearing candidate from a mine-local
 * manifest. Mocks the claude CLI spawn so tests stay fast and
 * deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

type SpawnCall = { cmd: string; args: string[]; stdin: string };
const spawnCalls: SpawnCall[] = [];
let nextChildBehavior: {
  stdout?: string;
  exitCode?: number;
  emitError?: Error;
} = { stdout: "", exitCode: 0 };

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    let stdinBuf = "";
    child.stdin.on("data", (b: Buffer) => { stdinBuf += b.toString("utf-8"); });
    child.stdin.on("finish", () => {
      spawnCalls.push({ cmd, args, stdin: stdinBuf });
      const beh = nextChildBehavior;
      queueMicrotask(() => {
        if (beh.emitError) {
          child.emit("error", beh.emitError);
          return;
        }
        if (beh.stdout) child.stdout.write(beh.stdout);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", beh.exitCode ?? 0);
      });
    });
    return child;
  }),
}));

let findAgentBinReturn: string | null = "/tmp/fake-claude-bin";
vi.mock("../../src/skillify/gate-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/skillify/gate-runner.js")>();
  return {
    ...actual,
    findAgentBin: () => findAgentBinReturn,
  };
});

import { parseAdvisorOutput, runAdvisor } from "../../src/skillify/advisor.js";
import { readLocalManifest, writeLocalManifest, type LocalManifestEntry } from "../../src/skillify/local-manifest.js";

const TMP_HOME = mkdtempSync(join(tmpdir(), "advisor-test-"));
const FAKE_BIN = "/tmp/fake-claude-bin";
const MANIFEST = join(TMP_HOME, "manifest.json");
const writeM = (m: import("../../src/skillify/local-manifest.js").LocalManifest) => writeLocalManifest(m, MANIFEST);

beforeEach(() => {
  spawnCalls.length = 0;
  nextChildBehavior = { stdout: "PICK: 1", exitCode: 0 };
  findAgentBinReturn = FAKE_BIN;
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
  writeFileSync(FAKE_BIN, "// fake claude", "utf-8");
});

afterEach(() => {
  try { rmSync(FAKE_BIN); } catch { /* best-effort */ }
});

function makeEntry(over: Partial<LocalManifestEntry>): LocalManifestEntry {
  return {
    skill_name: "k",
    canonical_path: "/x/SKILL.md",
    symlinks: [],
    source_session_ids: ["sid"],
    source_session_paths: ["/x/sid.jsonl"],
    source_agent: "claude_code",
    gate_agent: "claude_code",
    created_at: "2026-05-22T00:00:00.000Z",
    uploaded: false,
    ...over,
  };
}

describe("parseAdvisorOutput", () => {
  const candidates = [
    makeEntry({ skill_name: "alpha", insight: "a" }),
    makeEntry({ skill_name: "beta", insight: "b" }),
    makeEntry({ skill_name: "gamma", insight: "c" }),
  ];

  it("parses PICK: <n> at the start of the response", () => {
    const r = parseAdvisorOutput("PICK: 2", candidates);
    expect(r.pickedSkillName).toBe("beta");
  });

  it("parses PICK with surrounding whitespace and case", () => {
    const r = parseAdvisorOutput("\n  pick: 3  \n", candidates);
    expect(r.pickedSkillName).toBe("gamma");
  });

  it("parses REJECT_ALL with a reason", () => {
    const r = parseAdvisorOutput("REJECT_ALL: every candidate is meta-noise", candidates);
    expect(r.pickedSkillName).toBeNull();
    expect(r.reason).toContain("meta-noise");
  });

  it("returns null when PICK index is out of range", () => {
    const r = parseAdvisorOutput("PICK: 99", candidates);
    expect(r.pickedSkillName).toBeNull();
  });

  it("returns null on unparseable output (defensive: never blind-pick)", () => {
    const r = parseAdvisorOutput("Hmm, this is hard to say. Maybe beta?", candidates);
    expect(r.pickedSkillName).toBeNull();
    expect(r.reason).toContain("unparseable");
  });

  it("tolerates prose preamble and picks PICK pattern embedded later in stdout", () => {
    // Sonnet sometimes adds 'Looking at the candidates...' prose before the verdict.
    const r = parseAdvisorOutput("Looking at the candidates… PICK: 1", candidates);
    expect(r.pickedSkillName).toBe("alpha");
  });
});

describe("runAdvisor", () => {
  it("returns null when no manifest exists", async () => {
    const result = await runAdvisor(MANIFEST);
    expect(result).toBeNull();
    // No spawn should fire — no candidates to advise on.
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns null when manifest has no insight-bearing entries", async () => {
    writeM({
      created_at: "x",
      entries: [makeEntry({ skill_name: "a" }), makeEntry({ skill_name: "b" })],
    });
    const result = await runAdvisor(MANIFEST);
    expect(result).toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  it("trivial-picks when there's exactly one insight candidate (no sonnet call)", async () => {
    // Single candidate is automatically the winner — save the spend.
    const only = makeEntry({ skill_name: "lone", insight: "a real insight" });
    writeM({ created_at: "x", entries: [only] });
    const result = await runAdvisor(MANIFEST);
    expect(result?.pickedSkillName).toBe("lone");
    expect(result?.reason).toContain("trivial pick");
    // Manifest must now have primary: true marked.
    const re = readLocalManifest(MANIFEST);
    expect(re?.entries[0].primary).toBe(true);
    expect(spawnCalls).toHaveLength(0);
  });

  it("invokes claude with --model sonnet on the spawned process", async () => {
    writeM({
      created_at: "x",
      entries: [
        makeEntry({ skill_name: "a", insight: "insight a" }),
        makeEntry({ skill_name: "b", insight: "insight b" }),
      ],
    });
    nextChildBehavior = { stdout: "PICK: 1", exitCode: 0 };
    await runAdvisor(MANIFEST);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe(FAKE_BIN);
    const args = spawnCalls[0].args;
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    // Prompt fed via stdin includes both candidates.
    expect(spawnCalls[0].stdin).toContain("insight a");
    expect(spawnCalls[0].stdin).toContain("insight b");
  });

  it("marks the picked entry as primary in the manifest", async () => {
    writeM({
      created_at: "x",
      entries: [
        makeEntry({ skill_name: "a", insight: "a" }),
        makeEntry({ skill_name: "b", insight: "b" }),
        makeEntry({ skill_name: "c", insight: "c" }),
      ],
    });
    nextChildBehavior = { stdout: "PICK: 2", exitCode: 0 };
    const r = await runAdvisor(MANIFEST);
    expect(r?.pickedSkillName).toBeDefined();
    const re = readLocalManifest(MANIFEST)!;
    // newest-first ordering inside advisor → candidate index in prompt
    // maps to ranked order, NOT manifest order. We just verify SOME
    // entry was marked.
    const primaries = re.entries.filter(e => e.primary === true);
    expect(primaries).toHaveLength(1);
  });

  it("clears prior primary markings before applying the new pick", async () => {
    // Idempotency: re-running the advisor should replace the prior
    // primary, not add a second one.
    writeM({
      created_at: "x",
      entries: [
        makeEntry({ skill_name: "old-winner", insight: "old", primary: true }),
        makeEntry({ skill_name: "new-winner", insight: "new" }),
      ],
    });
    nextChildBehavior = { stdout: "PICK: 1", exitCode: 0 };
    await runAdvisor(MANIFEST);
    const re = readLocalManifest(MANIFEST)!;
    const primaries = re.entries.filter(e => e.primary === true);
    expect(primaries).toHaveLength(1);
  });

  it("leaves manifest untouched when advisor REJECT_ALLs", async () => {
    writeM({
      created_at: "x",
      entries: [
        makeEntry({ skill_name: "a", insight: "meta noise" }),
        makeEntry({ skill_name: "b", insight: "more meta noise" }),
      ],
    });
    nextChildBehavior = { stdout: "REJECT_ALL: all candidates are meta-noise", exitCode: 0 };
    const r = await runAdvisor(MANIFEST);
    expect(r?.pickedSkillName).toBeNull();
    const re = readLocalManifest(MANIFEST)!;
    expect(re.entries.filter(e => e.primary === true)).toHaveLength(0);
  });

  it("returns null cleanly when no claude CLI is available (fall back to recency pick)", async () => {
    findAgentBinReturn = null;
    writeM({
      created_at: "x",
      entries: [
        makeEntry({ skill_name: "a", insight: "a" }),
        makeEntry({ skill_name: "b", insight: "b" }),
      ],
    });
    const r = await runAdvisor(MANIFEST);
    expect(r).toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns an error result (not throw) when the spawn fails — caller falls through", async () => {
    writeM({
      created_at: "x",
      entries: [
        makeEntry({ skill_name: "a", insight: "a" }),
        makeEntry({ skill_name: "b", insight: "b" }),
      ],
    });
    nextChildBehavior = { emitError: new Error("ENOENT") };
    const r = await runAdvisor(MANIFEST);
    expect(r?.pickedSkillName).toBeNull();
    expect(r?.reason).toContain("advisor invocation failed");
  });
});
