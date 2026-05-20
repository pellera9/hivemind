import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard: the autoupdate path MUST pass `--skip-auth` to its
 * inner `hivemind install` spawn. If a future refactor drops it, the
 * background autoupdate would walk into the new consent prompt with closed
 * stdin and either hang on readline (TTY misdetected) or silently print the
 * headless hint on every session-start — both are user-visible regressions.
 *
 * Two layers (CLAUDE.md testing-rule 11: source AND bundle):
 *   1. Source grep — proves the literal is in src/cli/update.ts.
 *   2. Bundle grep — proves esbuild kept it in the shipped artifact.
 *
 * The runtime behavioral assertion lives in cli-update.test.ts; this file
 * is the negative-pattern guard (rule 8) that fails fast if someone
 * "cleans up" the args without understanding why the flag is there.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("autoupdate consent-gate insulation guard", () => {
  it("src/cli/update.ts spawns `hivemind install --skip-auth` (source-level)", () => {
    const src = readFileSync(join(repoRoot, "src/cli/update.ts"), "utf-8");
    // Match the exact spawn shape so a reordering or replacement is caught.
    expect(src).toMatch(/spawn\(\s*"hivemind"\s*,\s*\[\s*"install"\s*,\s*"--skip-auth"\s*\]\s*\)/);
  });

  it("bundle/cli.js carries the --skip-auth arg through the build (bundle-level)", () => {
    const bundlePath = join(repoRoot, "bundle/cli.js");
    if (!existsSync(bundlePath)) {
      // Skip cleanly when run before `npm run build`. The source-grep
      // assertion above is the load-bearing one; this is the second line
      // of defense for builds.
      return;
    }
    const built = readFileSync(bundlePath, "utf-8");
    // Both the literal arg and the surrounding spawn call must survive
    // bundling. esbuild keeps string literals intact, so this is a stable
    // assertion across minification flags.
    expect(built).toContain('"--skip-auth"');
    // esbuild may rename `spawn` to `spawn2`/`spawn3` to avoid collisions
    // with other bundled symbols, so match any identifier ending in `spawn`
    // (no underscore-prefixed lookalikes) followed by the exact arg shape.
    expect(built).toMatch(/\bspawn\w*\(\s*"hivemind"\s*,\s*\[\s*"install"\s*,\s*"--skip-auth"\s*\]\s*\)/);
  });
});
