/**
 * Install-time value-show: scan the user's recent local agent sessions for
 * repeatable mistakes and surface a concrete insight inline in the
 * `hivemind install` output, BEFORE the auth prompt.
 *
 * Captures the conversion moment: a fresh installer who declines sign-in
 * usually never returns. By showing a real finding from THEIR own work
 * up-front, the sign-in CTA becomes "keep this skill across machines"
 * instead of the abstract "shared memory" pitch.
 *
 * Guarded — only runs when:
 *   1. Claude Code CLI is on disk (the gate runner needs it).
 *   2. The user has at least one .jsonl session under ~/.claude/projects/
 *      (cold-install users have nothing to mine; we fall through silently).
 *   3. No mine-local manifest exists yet (re-installers already mined; the
 *      sentinel blocks duplicate runs and we don't want to nag them).
 *   4. TTY is attached (we need to prompt y/n).
 *
 * Failure modes (user declined, timed out, gate returned no insight, child
 * crashed) all return null — caller falls through to the existing
 * "🐝 One more step to unlock Hivemind" copy without surfacing an error.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAgentBin } from "../skillify/gate-runner.js";
import {
  getLatestInsightEntry,
  type LocalManifestEntry,
} from "../skillify/local-manifest.js";
import { runAdvisor } from "../skillify/advisor.js";

/**
 * Path roots are resolved at CALL time, not module-load time, so the
 * guards honor a HOME override applied after import (the unit tests
 * rely on this; production HOME never changes mid-process so the
 * runtime cost is irrelevant).
 */
function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}
function manifestPath(): string {
  return join(homedir(), ".claude", "hivemind", "local-mined.json");
}

/**
 * Hard cap on the synchronous scan during install. With session count
 * = 20 and concurrency = 4, haiku runs 5 sequential batches at ~30-60s
 * each → realistic wall clock 150-300s. 5 minutes is the ceiling
 * before we give up and fall through. The user opted into the wait
 * via the y/n prompt, so a long-but-bounded scan is acceptable; the
 * alternative (3-5 sessions) was empirically too few to escape the
 * recency-biased picker's tendency to pick conversational meta-
 * sessions on machines with rich history.
 */
const SCAN_TIMEOUT_MS = 300_000;

/**
 * Sessions to mine on the install-time pass. Bumped from 5 → 20 after
 * real-world testing: on a machine with ~340 sessions where the newest
 * dozen are all conversational/planning content (no coding mistakes),
 * --n 5 returned zero insights. The picker uses epsilon-greedy
 * (ε=0.3) so ~6 of 20 picks are random — high enough to reach back
 * into history and surface actual coding sessions where real
 * repeatable-mistake patterns live.
 */
const INSTALL_SCAN_SESSION_COUNT = 20;

/**
 * Cheap top-level scan: does any `~/.claude/projects/*` subdir contain
 * at least one `.jsonl`? We don't recurse into subagent dirs — the
 * mine-local worker has its own session picker, this guard only needs
 * to answer "is there anything to mine?".
 */
/**
 * Read the manifest mine-local just wrote and return true ONLY when
 * the entries array is empty. Distinguishes the "no skills written"
 * sentinel from a count-only mine (skills written, none with insight).
 * Returns false on any read/parse error to be safe — better to leave
 * a malformed file alone than delete real data we couldn't decode.
 */
function manifestIsTrulyEmpty(): boolean {
  const p = manifestPath();
  if (!existsSync(p)) return false;
  try {
    const m = JSON.parse(readFileSync(p, "utf-8")) as { entries?: unknown };
    return Array.isArray(m.entries) && m.entries.length === 0;
  } catch {
    return false;
  }
}

function hasLocalClaudeSessions(): boolean {
  const projectsDir = claudeProjectsDir();
  if (!existsSync(projectsDir)) return false;
  let subdirs: string[];
  try {
    subdirs = readdirSync(projectsDir);
  } catch {
    return false;
  }
  for (const sub of subdirs) {
    let files: string[];
    try {
      files = readdirSync(join(projectsDir, sub));
    } catch {
      continue;
    }
    if (files.some(f => f.endsWith(".jsonl"))) return true;
  }
  return false;
}

/**
 * Guards: every condition that must hold before we even prompt the user
 * for a scan. Returning false means "skip the offer entirely, fall
 * through to the standard auth copy" — no banner, no half-state.
 */
export function canOfferInstallScan(): boolean {
  const bin = findAgentBin("claude_code");
  if (!bin || !existsSync(bin)) return false;
  if (!hasLocalClaudeSessions()) return false;
  if (existsSync(manifestPath())) return false;
  return true;
}

/**
 * Spawn the worktree's own `hivemind skillify mine-local` as a detached-
 * style child, but await its exit synchronously (with timeout). Using
 * `process.execPath` + `process.argv[1]` guarantees we run the SAME CLI
 * bundle the user is currently inside — no version skew between the
 * install flow and the worker that does the mining.
 *
 * stdio is silenced so the install UX stays clean. mine-local's own
 * logs land in `~/.claude/hooks/mine-local.log` for postmortems.
 *
 * Returns the latest insight-bearing manifest entry if mining produced
 * one, or null for every failure path (timeout, non-zero exit, no
 * insight in the manifest).
 */
export function runInstallScan(): Promise<LocalManifestEntry | null> {
  return new Promise((resolve) => {
    const cliPath = process.argv[1];
    if (!cliPath || !existsSync(cliPath)) {
      resolve(null);
      return;
    }
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "skillify",
        "mine-local",
        "--n",
        String(INSTALL_SCAN_SESSION_COUNT),
        // The install copy advertises a "Claude Code" scan, so filter
        // the mine-local picker to claude_code sessions. Without this,
        // mine-local walks every installed agent (Codex, Cursor,
        // Hermes, pi) and could surface an insight from a Codex
        // session despite what we promised — codex PR #198 P2.
        "--only",
        "claude_code",
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        // HIVEMIND_CAPTURE=false: the spawned mine-local would otherwise
        // try to capture its own activity, which is a no-op without
        // credentials but spams the log. Keep it quiet.
        env: { ...process.env, HIVEMIND_CAPTURE: "false" },
      },
    );

    let settled = false;
    const finish = (result: LocalManifestEntry | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best-effort */ }
      finish(null);
    }, SCAN_TIMEOUT_MS);

    child.on("close", async (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) { finish(null); return; }
      // After mine-local exits cleanly, the manifest is written. Run
      // the advisor (sonnet) over all insight-bearing candidates to
      // mark the BEST one as primary. The A/B comparison showed a
      // significant jump in surfaced-insight quality with the advisor
      // pass: it consistently rejects meta-noise / vague candidates
      // and picks the most concrete + counted finding. Falls through
      // silently on any advisor error (timeout, no claude CLI, sonnet
      // rejects all) — getLatestInsightEntry just uses the recency
      // tiebreak.
      try { await runAdvisor(); } catch { /* fall through to recency pick */ }
      let entry: LocalManifestEntry | null = null;
      try { entry = getLatestInsightEntry(); } catch { /* keep null */ }
      if (!entry && manifestIsTrulyEmpty()) {
        // ONLY delete the manifest when mine-local wrote a literal
        // empty sentinel (entries: []). When mine-local DID produce
        // skills but the gate omitted `insight` on all of them, the
        // manifest still has value — countLocalManifestEntries() will
        // surface the count via the legacy SessionStart banner branch,
        // and a future `push-local` flow needs the row metadata. The
        // earlier blanket-unlink path was over-aggressive (codex
        // PR #198 P2): it told users "no patterns found" even when
        // skills had been written, and re-armed the background auto-
        // mine for the next session unnecessarily. canOfferInstallScan
        // guarantees there was no pre-existing manifest, so an empty
        // sentinel here is definitively from THIS spawn.
        try { unlinkSync(manifestPath()); } catch { /* best-effort */ }
      }
      finish(entry);
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/**
 * Pure renderer for the post-scan banner. Returns the multi-line block
 * the install flow prints when an insight was found. Kept pure so the
 * unit test can assert on the rendered output without standing up a
 * real mine-local run.
 *
 * The skill name is rendered as a backticked code span — same as the
 * SessionStart banner — and the insight is truncated to 200 chars so
 * a verbose haiku output stays readable inline in the terminal.
 */
export function formatScanResult(entry: LocalManifestEntry): string {
  const rawInsight = (entry.insight ?? "").replace(/\s+/g, " ").trim();
  // Cap at 280 chars (same as the parseMultiVerdict storage cap), so we
  // never truncate beyond what was persisted. The earlier 200-char cap
  // sometimes lost the punchline of haiku's insights mid-sentence —
  // 280 is the longest a stored insight can ever be.
  const insight = rawInsight.length > 280
    ? rawInsight.slice(0, 277).replace(/\s\S*$/, "") + "…"
    : rawInsight;
  return (
    `✓ Found a pattern in your past sessions:\n` +
    `   📌 ${insight}\n` +
    `   ✨ Skill \`${entry.skill_name}\` ready to catch it next time`
  );
}
