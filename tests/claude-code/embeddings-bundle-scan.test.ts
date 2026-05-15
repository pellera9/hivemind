import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle-level guards that the embed-daemon fix actually lands in every
 * shipped agent bundle. Per the project testing philosophy: source tests
 * prove the helpers are correct, bundle tests prove the build didn't drop
 * the helpers, re-inline an old pattern, or otherwise regress on the
 * shipped artifact.
 *
 * A 30-second reviewer guardrail: scan the shipped JS for the literal
 * strings that prove each fix shipped to each agent.
 */

const repoRoot = process.cwd();

interface AgentBundle {
  agent: "claude-code" | "codex" | "cursor" | "hermes";
  embedDaemon: string;
  captureHook: string;
}

const AGENTS: AgentBundle[] = [
  {
    agent: "claude-code",
    embedDaemon: join(repoRoot, "claude-code", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "claude-code", "bundle", "capture.js"),
  },
  {
    agent: "codex",
    embedDaemon: join(repoRoot, "codex", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "codex", "bundle", "capture.js"),
  },
  {
    agent: "cursor",
    embedDaemon: join(repoRoot, "cursor", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "cursor", "bundle", "capture.js"),
  },
  {
    agent: "hermes",
    embedDaemon: join(repoRoot, "hermes", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "hermes", "bundle", "capture.js"),
  },
];

describe("shipped embed-daemon.js — explicit transformers resolver", () => {
  for (const a of AGENTS) {
    describe(a.agent, () => {
      it(`embed-daemon.js exists at the shipped path`, () => {
        expect(existsSync(a.embedDaemon), `missing: ${a.embedDaemon}`).toBe(true);
      });

      it(`embed-daemon.js loads transformers via the canonical shared-deps location`, () => {
        const src = readFileSync(a.embedDaemon, "utf-8");
        // Positive: canonical shared-deps path (".hivemind" + "embed-deps"
        // adjacent string literals survive esbuild's join() reformatting).
        expect(src).toMatch(/\.hivemind/);
        expect(src).toMatch(/embed-deps/);
        // Positive: createRequire-rooted resolve survived bundling.
        expect(src).toMatch(/createRequire/);
      });

      it(`embed-daemon.js throws an actionable error pointing at "hivemind embeddings install"`, () => {
        const src = readFileSync(a.embedDaemon, "utf-8");
        // The wrapper error message must survive the bundle so the
        // client-side log line tells the user what to do.
        expect(src).toContain("hivemind embeddings install");
      });
    });
  }
});

describe("shipped capture.js — self-heal + visible-failure notification", () => {
  for (const a of AGENTS) {
    describe(a.agent, () => {
      it(`capture.js exists`, () => {
        expect(existsSync(a.captureHook), `missing: ${a.captureHook}`).toBe(true);
      });

      it(`capture.js invokes the self-heal helper`, () => {
        const src = readFileSync(a.captureHook, "utf-8");
        expect(src).toContain("ensurePluginNodeModulesLink");
      });

      it(`capture.js carries the embed-deps-missing notification dedupKey`, () => {
        const src = readFileSync(a.captureHook, "utf-8");
        // The notification ID is what the SessionStart drain renders.
        expect(src).toContain("embed-deps-missing");
      });

      it(`capture.js still suppresses notifications when user-disabled (no nag for explicit opt-out)`, () => {
        const src = readFileSync(a.captureHook, "utf-8");
        // The guard must survive in the shipped artifact.
        expect(src).toMatch(/user-disabled/);
      });
    });
  }
});

describe("shipped bundle/cli.js — full embeddings subcommand surface", () => {
  const cliPath = join(repoRoot, "bundle", "cli.js");

  it("bundle/cli.js exists", () => {
    expect(existsSync(cliPath), `missing: ${cliPath}`).toBe(true);
  });

  it("dispatcher recognises every embeddings subcommand", () => {
    const src = readFileSync(cliPath, "utf-8");
    expect(src).toContain('"install"');
    expect(src).toContain('"enable"');
    expect(src).toContain('"disable"');
    expect(src).toContain('"uninstall"');
    expect(src).toContain('"status"');
  });

  it("CLI references ~/.deeplake/config.json so the model knows where state lives", () => {
    const src = readFileSync(cliPath, "utf-8");
    expect(src).toContain("~/.deeplake/config.json");
  });
});
