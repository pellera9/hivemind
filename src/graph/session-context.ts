/**
 * SessionStart inject for the local code graph (Phase 3 v1.1).
 *
 * Goal: surface the graph to Claude on every SessionStart so it knows the
 * snapshot exists and can read it directly for code-relationship questions
 * ("what calls X?", "what imports Y?") instead of grepping the source tree.
 *
 * Hot-path constraint: SessionStart inject runs on EVERY session start. We
 * cannot afford to parse the ~1 MB snapshot JSON here. Instead we read the
 * small `.last-build.json` file (single small read, fields already populated
 * by writeSnapshot). Total cost: ~1 ms.
 *
 * Honest scope hints in the inject text:
 *   - "TypeScript only" — Phase 1 limitation, makes Claude not waste a Read
 *     on Python/Rust expecting to find them in the graph.
 *   - "AST-based" — call/import/reference edges; NOT semantic similarity.
 *     The semantic layer is a deliberate v1.2 follow-up.
 *   - "may be stale" — the graph is rebuilt at most once per
 *     HIVEMIND_GRAPH_TICK_INTERVAL_MS (default 10 min) so it can lag
 *     uncommitted in-flight edits. The age line lets Claude judge.
 *
 * Returns null when:
 *   - no graph has ever been built for this repo
 *   - the cwd isn't a recognizable project (deriveProjectKey fallback)
 *   - the last-build file is missing/corrupt
 * — in all these cases SessionStart simply skips the inject.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { readLastBuild } from "./last-build.js";
import { repoDir } from "./snapshot.js";
import { deriveProjectKey } from "../utils/repo-identity.js";

export interface GraphContextDeps {
  /** Override for tests; defaults to Date.now(). */
  now?: () => number;
}

/**
 * Compose the SessionStart inject line for the local graph, or null when
 * there's no graph to surface. Never throws — all errors return null so a
 * broken graph state cannot block SessionStart.
 */
export function graphContextLine(cwd: string, deps: GraphContextDeps = {}): string | null {
  let key: string;
  let snapshotsDir: string;
  let baseDir: string;
  try {
    key = deriveProjectKey(cwd).key;
    baseDir = repoDir(key);
    snapshotsDir = join(baseDir, "snapshots");
  } catch {
    return null;
  }

  // No snapshots directory → never built. Cheaper than readLastBuild's
  // file-open dance for the common "first session in a fresh repo" case.
  if (!existsSync(snapshotsDir)) return null;

  const last = readLastBuild(baseDir);
  if (last === null) return null;

  const now = (deps.now ?? Date.now)();
  const ageMs = Math.max(0, now - last.ts);

  // Compose the metadata line. Counts are optional (older builds didn't
  // record them); render "?" rather than fabricating a number.
  const nodesStr = last.node_count !== undefined ? String(last.node_count) : "?";
  const edgesStr = last.edge_count !== undefined ? String(last.edge_count) : "?";
  const commitStr = last.commit_sha !== null ? last.commit_sha.slice(0, 7) : "no-commit";
  const ageStr = formatAge(ageMs);
  const snapshotFile = last.commit_sha ?? last.snapshot_sha256;
  const snapshotPath = join(snapshotsDir, `${snapshotFile}.json`);

  return [
    "",
    "LOCAL CODE GRAPH (TypeScript only, AST-based):",
    `  ${snapshotPath}`,
    `  ${nodesStr} nodes, ${edgesStr} edges (commit ${commitStr}, built ${ageStr} ago)`,
    "  For code-structure questions ('what calls X?', 'what imports Y?',",
    "  'what does Z depend on?'), read the snapshot JSON directly — it's",
    "  faster than grepping the tree and gives complete call/import/ref edges.",
    "  Limitations: TypeScript-only, AST-only (no semantic-similarity edges yet),",
    `  and may lag the working copy by up to the auto-rebuild interval.`,
  ].join("\n");
}

/**
 * Human-friendly age rendering: "12s", "3m", "2h", "4d". Always one unit,
 * truncated (not rounded) so "1m 59s" reports as "1m" — better to under-report
 * freshness than over-report it.
 */
function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
