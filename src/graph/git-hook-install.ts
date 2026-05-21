/**
 * git post-commit hook installer/uninstaller for the codebase-graph feature.
 *
 * Idempotent. Detects our own hook via sentinel comments so we can safely
 * coexist with (or refuse to clobber) a user-managed hook.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Sentinel markers — used to find and replace ONLY the lines we own. */
export const HOOK_BEGIN_MARKER = "# HIVEMIND_GRAPH_HOOK_BEGIN — managed by `hivemind graph init`";
export const HOOK_END_MARKER = "# HIVEMIND_GRAPH_HOOK_END";

/** Lines we write between the markers. */
const HOOK_BODY = [
  "# Async-detached so commits never wait. Threshold-gate + cache make",
  "# typical re-runs ~85ms. Logs go to ~/.hivemind/graphs/<key>/.post-commit.log",
  'nohup hivemind graph build --trigger post-commit >> "$HOME/.hivemind/post-commit.log" 2>&1 &',
];

const SHEBANG = "#!/bin/sh";

export type InstallStatus =
  | { kind: "installed"; path: string; wasNew: boolean }
  | { kind: "already-ours"; path: string }
  | { kind: "foreign-hook"; path: string; hint: string };

export type UninstallStatus =
  | { kind: "removed"; path: string; wholeFileDeleted: boolean }
  | { kind: "no-hook"; path: string }
  | { kind: "not-ours"; path: string; hint: string };

export interface InstallOptions {
  /** If true and there's a foreign hook, OVERWRITE it. Default false. */
  force?: boolean;
}

/**
 * Find the .git directory for `cwd`. Returns the absolute path or null when
 * cwd is not inside a git repo. Uses `git rev-parse --git-path hooks` so
 * worktrees and shared-hook setups land in the right place.
 */
export function gitHooksDir(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return null;
    // git returns a path relative to cwd; resolve via path.resolve.
    // For absolute paths it's a no-op.
    return resolve(cwd, out);
  } catch {
    return null;
  }
}

export function postCommitHookPath(cwd: string): string | null {
  const hooksDir = gitHooksDir(cwd);
  return hooksDir === null ? null : join(hooksDir, "post-commit");
}

/**
 * Install our managed block in .git/hooks/post-commit.
 *
 * Cases:
 *   1. No file at all → write a fresh hook with shebang + our block. Mark +x.
 *   2. File exists, contains our markers → leave alone (idempotent).
 *   3. File exists, no markers → refuse unless `force` is true; with force,
 *      overwrite the whole file (the user opted in).
 */
export function installPostCommitHook(cwd: string, opts: InstallOptions = {}): InstallStatus {
  const path = postCommitHookPath(cwd);
  if (path === null) {
    return { kind: "foreign-hook", path: "", hint: "not in a git repo (no .git directory found)" };
  }

  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    if (containsOurMarkers(content)) {
      return { kind: "already-ours", path };
    }
    if (!opts.force) {
      return {
        kind: "foreign-hook",
        path,
        hint: `existing hook at ${path} is not managed by hivemind; pass --force to overwrite, or merge our block manually (between '${HOOK_BEGIN_MARKER}' and '${HOOK_END_MARKER}')`,
      };
    }
    // force=true → fall through to write
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildHookFile(), { mode: 0o755 });
  // chmod +x — writeFileSync's mode is honored on most systems but
  // not universally; re-chmod to be safe.
  try {
    chmodSync(path, 0o755);
  } catch {
    // best-effort
  }
  return { kind: "installed", path, wasNew: true };
}

/**
 * Remove the post-commit hook IF it's ours. Cases:
 *   1. File missing → no-op.
 *   2. File contains ONLY our block (plus shebang + whitespace) → delete the file.
 *   3. File contains our markers + other user content → strip just our block
 *      (between markers, inclusive), leave the rest intact.
 *   4. File exists but no markers → refuse.
 */
export function uninstallPostCommitHook(cwd: string): UninstallStatus {
  const path = postCommitHookPath(cwd);
  if (path === null) {
    return { kind: "no-hook", path: "" };
  }
  if (!existsSync(path)) {
    return { kind: "no-hook", path };
  }
  const content = readFileSync(path, "utf8");
  if (!containsOurMarkers(content)) {
    return {
      kind: "not-ours",
      path,
      hint: `existing hook at ${path} is not managed by hivemind; remove it manually if you want it gone`,
    };
  }
  const stripped = stripOurBlock(content);
  // Whole-file deletion if nothing meaningful remains (only shebang + whitespace).
  const meaningful = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#!"));
  if (meaningful.length === 0) {
    unlinkSync(path);
    return { kind: "removed", path, wholeFileDeleted: true };
  }
  writeFileSync(path, stripped);
  return { kind: "removed", path, wholeFileDeleted: false };
}

/** Returns true when both markers are present in the file. */
export function containsOurMarkers(content: string): boolean {
  return content.includes(HOOK_BEGIN_MARKER) && content.includes(HOOK_END_MARKER);
}

/** Remove everything between BEGIN and END markers, inclusive (and one trailing newline). */
function stripOurBlock(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.includes(HOOK_BEGIN_MARKER));
  const end = lines.findIndex((l) => l.includes(HOOK_END_MARKER));
  if (start === -1 || end === -1 || end < start) return content;
  // Drop start..end inclusive
  const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Compose the full post-commit file content (shebang + our managed block). */
export function buildHookFile(): string {
  return [
    SHEBANG,
    "",
    HOOK_BEGIN_MARKER,
    ...HOOK_BODY,
    HOOK_END_MARKER,
    "",
  ].join("\n");
}
