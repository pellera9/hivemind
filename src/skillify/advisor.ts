/**
 * Insight advisor — runs after a mine-local pass to pick the BEST
 * insight-bearing candidate from a manifest. Calls sonnet via the
 * user's claude CLI (haiku is the executor that produces N candidates
 * in parallel; sonnet is the advisor that selects one).
 *
 * Pattern (per Anthropic's "Executor/Advisor"):
 *   - Executor (haiku, parallel × N): cheap, runs once per session,
 *     produces 0-3 skill candidates each. No quality floor — haiku
 *     sometimes emits meta-commentary ("user asked to save this rule")
 *     because the session it saw was a meta-conversation, not coding.
 *   - Advisor (sonnet, single call): reads ALL candidates, ranks by
 *     quality criteria, marks the winner with `primary: true` in the
 *     manifest. If every candidate is meta-noise / vague, returns
 *     null (no banner surfaces — falls back to the count line).
 *
 * Cost: one sonnet call per mine-local run (~$0.10-0.30 with the
 * candidate set sizes we cap at). Worth the spend at install time,
 * where surface attention is the scarce resource and we get one shot
 * at the impression.
 *
 * The advisor is intentionally separate from gate-runner so the
 * haiku-parallel path stays untouched. We invoke `claude --model sonnet`
 * directly with stdin-fed prompt + parse a deterministic single-line
 * response.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { findAgentBin } from "./gate-runner.js";
import {
  LOCAL_MANIFEST_PATH,
  readLocalManifest,
  writeLocalManifest,
  type LocalManifestEntry,
} from "./local-manifest.js";

/**
 * Hard cap on the advisor call. Sonnet on a small candidate list
 * (typically 4-15 entries) returns in ~5-20s. 60s ceiling before we
 * give up and leave the manifest unmarked — the rule will fall back
 * to the recency-based pick.
 */
const ADVISOR_TIMEOUT_MS = 60_000;

/**
 * Maximum candidates we send to the advisor. Mine-local typically
 * produces 0-3 candidates per session, capped at ~24 total for the
 * default --n 8 run. We send up to 20 — beyond that the prompt gets
 * long and sonnet's signal-to-noise drops. If a future run yields
 * more, we sample the newest 20.
 */
const MAX_CANDIDATES = 20;

export interface AdvisorResult {
  /** The picked entry's skill_name, or null if all candidates were rejected. */
  pickedSkillName: string | null;
  /** Sonnet's free-text justification (kept for debug logs / observability). */
  reason: string;
  /** Raw stdout from the model — preserved for debug only, not parsed beyond pick/reject. */
  rawOutput: string;
}

function buildAdvisorPrompt(candidates: LocalManifestEntry[]): string {
  const lines: string[] = [
    "You are reviewing skill candidates extracted from a user's coding sessions.",
    "Pick the ONE candidate whose `insight` field is most useful to show the user as a",
    "concrete finding from their past work. Reply on EXACTLY ONE LINE.",
    "",
    "GOOD insights are:",
    "  - Concrete and counted (cite specific numbers, file names, durations)",
    "  - About a real coding mistake or pattern the USER made (in 2nd person — \"You did X\")",
    "  - Actionable: the user can change behavior based on knowing this",
    "",
    "BAD insights (REJECT these) are:",
    "  - Meta-commentary about why the skill was saved (\"User explicitly requested...\")",
    "  - Vague / generic engineering platitudes the user already knows",
    "  - About someone other than the user (a teammate, a third party)",
    "  - Hypothetical (\"could lead to...\", \"might cause...\") rather than observed",
    "",
    "Output format — STRICT, one line only:",
    "  PICK: <number 1-N>",
    "OR",
    "  REJECT_ALL: <short reason why every candidate failed>",
    "",
    "Candidates:",
  ];
  for (const [i, c] of candidates.entries()) {
    lines.push(`${i + 1}. name=${c.skill_name}  insight=${JSON.stringify((c.insight ?? "").slice(0, 400))}`);
  }
  return lines.join("\n");
}

/**
 * Parse the advisor's single-line verdict. Defensive against extra
 * whitespace, fenced code blocks, and prose preludes that sonnet
 * sometimes emits despite the "EXACTLY ONE LINE" instruction.
 */
export function parseAdvisorOutput(raw: string, candidates: LocalManifestEntry[]): AdvisorResult {
  const cleaned = raw.trim();
  const pickMatch = cleaned.match(/PICK:\s*(\d+)/i);
  if (pickMatch) {
    const idx = parseInt(pickMatch[1], 10) - 1;
    if (idx >= 0 && idx < candidates.length) {
      return {
        pickedSkillName: candidates[idx].skill_name,
        reason: cleaned,
        rawOutput: raw,
      };
    }
  }
  const rejectMatch = cleaned.match(/REJECT_ALL:\s*(.+)/i);
  if (rejectMatch) {
    return { pickedSkillName: null, reason: rejectMatch[1].trim(), rawOutput: raw };
  }
  // Unparseable response — treat as reject so we don't pick blindly.
  return { pickedSkillName: null, reason: `unparseable advisor output: ${cleaned.slice(0, 120)}`, rawOutput: raw };
}

/**
 * Invoke the user's `claude --model sonnet` CLI with the prompt piped
 * to stdin. Mirrors mine-local's stdin-gate trick to avoid MAX_ARG_STRLEN.
 */
function runAdvisorGate(prompt: string, claudeBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, [
      "-p",
      "--no-session-persistence",
      "--model", "sonnet",
      "--permission-mode", "bypassPermissions",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err: Error | null, out: string): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(out);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best-effort */ }
      finish(new Error(`advisor timed out after ${ADVISOR_TIMEOUT_MS}ms`), "");
    }, ADVISOR_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    child.on("error", (e: Error) => { clearTimeout(timer); finish(e, ""); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(new Error(`advisor CLI exit ${code}; stderr=${stderr.slice(0, 200)}`), "");
      } else {
        finish(null, stdout);
      }
    });
    child.stdin.on("error", (e: Error) => { clearTimeout(timer); finish(e, ""); });
    child.stdin.end(prompt);
  });
}

/**
 * Read the manifest, run the advisor over its insight-bearing entries,
 * mark the picked entry with `primary: true`, write back. Returns the
 * AdvisorResult (or null when there's nothing to advise on).
 *
 * Idempotent on the manifest schema: previously-marked primary entries
 * are cleared before the new pick is set, so a re-run replaces the
 * marking instead of accumulating.
 */
export async function runAdvisor(
  manifestPath: string = LOCAL_MANIFEST_PATH,
): Promise<AdvisorResult | null> {
  const m = readLocalManifest(manifestPath);
  if (!m || !Array.isArray(m.entries)) return null;
  const insightBearing = m.entries.filter(
    e => e && typeof e.insight === "string" && e.insight.trim().length > 0,
  );
  if (insightBearing.length === 0) return null;
  // No advisor call needed when there's exactly one candidate — it's
  // automatically the best one. Save the sonnet spend.
  if (insightBearing.length === 1) {
    insightBearing[0].primary = true;
    writeLocalManifest(m, manifestPath);
    return {
      pickedSkillName: insightBearing[0].skill_name,
      reason: "trivial pick (single candidate)",
      rawOutput: "",
    };
  }
  const claudeBin = findAgentBin("claude_code");
  if (!claudeBin || !existsSync(claudeBin)) {
    // Without a claude CLI we can't call sonnet. Leave the manifest as
    // is — the existing recency-based pick still works.
    return null;
  }
  // Cap at MAX_CANDIDATES newest-first so the prompt stays bounded.
  const ranked = [...insightBearing]
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, MAX_CANDIDATES);
  const prompt = buildAdvisorPrompt(ranked);
  let raw: string;
  try {
    raw = await runAdvisorGate(prompt, claudeBin);
  } catch (err) {
    return {
      pickedSkillName: null,
      reason: `advisor invocation failed: ${(err as Error).message}`,
      rawOutput: "",
    };
  }
  const result = parseAdvisorOutput(raw, ranked);
  if (result.pickedSkillName) {
    // Clear any prior primary flags, then mark the picked entry. Same
    // skill_name match — we mutate the entry in the original manifest
    // (not a copy) so the write-back persists.
    for (const e of m.entries) {
      if (e && e.primary === true) delete e.primary;
    }
    for (const e of m.entries) {
      if (e && e.skill_name === result.pickedSkillName) {
        e.primary = true;
        break;
      }
    }
    writeLocalManifest(m, manifestPath);
  }
  return result;
}
