/**
 * Single source of truth for the `hivemind skillify ...` command list that
 * gets injected into each agent's SessionStart context block.
 *
 * Before this module existed, the same command list was hand-maintained in
 * five places (the four per-agent session-start.ts files plus pi's inline
 * extension), and adding a new subcommand meant remembering to touch all
 * five. The `agents-deployment-session-start-injection` skill captures that
 * rule, but the only way to make it impossible to forget is to centralize
 * the data.
 *
 * Four of the five callers can import this module directly. pi's extension
 * is shipped as raw .ts loaded by pi's runtime and intentionally has zero
 * non-builtin deps — see `pi/extension-source/hivemind.ts` — so its copy
 * of the list is duplicated with a "MIRROR of skillify-spec.ts" comment.
 * A bundle-scan test guards against drift.
 */

export interface SkillifyCommand {
  /** The full command form as it appears in the injection text. */
  cmd: string;
  /** One-line description, dash-separated from `cmd` in the rendered block. */
  desc: string;
}

export const SKILLIFY_COMMANDS: SkillifyCommand[] = [
  { cmd: "hivemind skillify",                            desc: "show scope, team, install, per-project state" },
  { cmd: "hivemind skillify pull",                       desc: "sync project skills from the org table to local FS" },
  { cmd: "hivemind skillify pull --user <email>",        desc: "only skills authored by that user" },
  { cmd: "hivemind skillify pull --users <a,b,c>",       desc: "only skills from those authors" },
  { cmd: "hivemind skillify pull --all-users",           desc: 'explicit "no author filter" (default)' },
  { cmd: "hivemind skillify pull --to <project|global>", desc: "install location (project=cwd/.claude/skills, global=~/.claude/skills)" },
  { cmd: "hivemind skillify pull --dry-run",             desc: "preview without touching disk" },
  { cmd: "hivemind skillify pull --force",               desc: "overwrite local files even if up-to-date (creates .bak)" },
  { cmd: "hivemind skillify pull <skill-name>",          desc: "pull only that one skill (combines with --user)" },
  { cmd: "hivemind skillify unpull",                     desc: "remove every skill previously installed by pull" },
  { cmd: "hivemind skillify unpull --user <email>",      desc: "remove only that author's pulls" },
  { cmd: "hivemind skillify unpull --not-mine",          desc: "remove all pulls except your own" },
  { cmd: "hivemind skillify unpull --dry-run",           desc: "preview without touching disk" },
  { cmd: "hivemind skillify scope <me|team|org>",        desc: "sharing scope for newly mined skills" },
  { cmd: "hivemind skillify install <project|global>",   desc: "default install location for new skills" },
  { cmd: "hivemind skillify promote <skill-name>",       desc: "move a project skill to the global location" },
  { cmd: "hivemind skillify team add|remove|list <name>", desc: "manage team member list" },
  { cmd: "hivemind skillify mine-local",                 desc: "one-shot: mine skills from local sessions (no auth needed)" },
];

/**
 * Render the command list as a dash-bulleted block suitable for embedding
 * in a SessionStart context literal. Padding width is computed from the
 * longest `cmd` so the dashes line up across rows.
 *
 * The "Skill management ..." header line is NOT included — callers add
 * their own preamble (claude_code uses a slightly different wording than
 * codex/cursor/hermes, and centralizing the header would force a churn
 * we don't need yet).
 */
export function renderSkillifyCommands(): string {
  const maxLen = Math.max(...SKILLIFY_COMMANDS.map(c => c.cmd.length));
  return SKILLIFY_COMMANDS
    .map(c => `- ${c.cmd.padEnd(maxLen + 2)} — ${c.desc}`)
    .join("\n");
}
