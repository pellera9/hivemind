import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { graphContextLine } from "../../../src/graph/session-context.js";
import { writeLastBuild } from "../../../src/graph/last-build.js";
import { repoDir } from "../../../src/graph/snapshot.js";
import { deriveProjectKey } from "../../../src/utils/repo-identity.js";

// graphContextLine is anchored on ~/.hivemind/graphs/<key>/ via repoDir(key),
// not on the cwd. To exercise it we need a cwd whose deriveProjectKey gives a
// repo key we can pre-populate. We mkdtemp a directory, init it as a git repo
// is overkill — deriveProjectKey falls back to a path-based key for non-git
// dirs, which is fine here.

describe("graphContextLine", () => {
  let cwd: string;
  let baseDir: string;
  let snapshotsDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "session-context-cwd-"));
    const { key } = deriveProjectKey(cwd);
    baseDir = repoDir(key);
    snapshotsDir = join(baseDir, "snapshots");
    // Start clean: previous test runs against the same key shouldn't leak.
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
  });

  it("returns null when no graph dir exists", () => {
    expect(graphContextLine(cwd)).toBeNull();
  });

  it("returns null when snapshots dir is missing even if other files exist", () => {
    // Build a partial state: baseDir + .last-build.json but no snapshots/
    // dir. This shouldn't surface a graph line — the snapshot file is the
    // useful payload to point Claude at.
    mkdirSync(baseDir, { recursive: true });
    writeLastBuild(baseDir, {
      ts: Date.now(),
      commit_sha: "abc1234",
      snapshot_sha256: "deadbeef",
      node_count: 100,
      edge_count: 200,
    });
    expect(graphContextLine(cwd)).toBeNull();
  });

  it("returns null when snapshots/ exists but .last-build.json is missing", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    expect(graphContextLine(cwd)).toBeNull();
  });

  it("returns null when .last-build.json is corrupt", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(join(baseDir, ".last-build.json"), "{not valid json");
    expect(graphContextLine(cwd)).toBeNull();
  });

  it("formats the full inject with counts, commit, age, and the snapshot path", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    writeLastBuild(baseDir, {
      ts: 1_000_000,
      commit_sha: "abc1234deadbeef",
      snapshot_sha256: "fingerprint",
      node_count: 2544,
      edge_count: 2851,
    });
    // Pin "now" to ts + 2 minutes 30 seconds → "2m" (truncated, not rounded)
    const line = graphContextLine(cwd, { now: () => 1_000_000 + 150_000 });
    expect(line).not.toBeNull();
    expect(line).toContain("2544 nodes, 2851 edges");
    expect(line).toContain("commit abc1234"); // 7-char trimmed
    expect(line).toContain("built 2m ago");   // truncated formatAge
    // Snapshot path is keyed by commit_sha when present
    expect(line).toContain(join(snapshotsDir, "abc1234deadbeef.json"));
    expect(line).toContain("TypeScript only, AST-based");
    expect(line).toContain("no semantic-similarity edges yet");
  });

  it("renders '?' for counts on legacy files without node_count/edge_count", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    // Write a last-build object that lacks node_count/edge_count — simulates
    // a file written by a build older than the new optional fields.
    writeFileSync(
      join(baseDir, ".last-build.json"),
      JSON.stringify({ ts: 1_000_000, commit_sha: "abc1234", snapshot_sha256: "x" }),
    );
    const line = graphContextLine(cwd, { now: () => 1_001_000 });
    expect(line).not.toBeNull();
    expect(line).toContain("? nodes, ? edges");
  });

  it("uses 'no-commit' label and snapshot_sha256 in path when commit_sha is null", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    writeLastBuild(baseDir, {
      ts: 1_000_000,
      commit_sha: null,
      snapshot_sha256: "feedface",
      node_count: 1,
      edge_count: 0,
    });
    const line = graphContextLine(cwd, { now: () => 1_001_000 })!;
    expect(line).toContain("commit no-commit");
    expect(line).toContain(join(snapshotsDir, "feedface.json"));
  });

  it("clamps negative age (clock skew between writer and reader) to 0s", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    writeLastBuild(baseDir, {
      ts: 5_000_000,
      commit_sha: "abc1234",
      snapshot_sha256: "x",
      node_count: 1,
      edge_count: 0,
    });
    // "now" is in the past relative to ts: must NOT produce a negative age.
    const line = graphContextLine(cwd, { now: () => 4_000_000 })!;
    expect(line).toContain("built 0s ago");
  });

  it("age formatter buckets correctly (s, m, h, d) and truncates", () => {
    mkdirSync(snapshotsDir, { recursive: true });
    const cases: Array<[number, string]> = [
      [59_000, "59s"],         // just under a minute
      [60_000, "1m"],          // exactly a minute
      [3_599_000, "59m"],      // just under an hour
      [3_600_000, "1h"],       // exactly an hour
      [86_399_000, "23h"],     // just under a day
      [86_400_000, "1d"],      // exactly a day
    ];
    for (const [ageMs, expected] of cases) {
      writeLastBuild(baseDir, {
        ts: 1_000_000,
        commit_sha: "abc1234",
        snapshot_sha256: "x",
        node_count: 1,
        edge_count: 0,
      });
      const line = graphContextLine(cwd, { now: () => 1_000_000 + ageMs })!;
      expect(line).toContain(`built ${expected} ago`);
    }
  });
});
