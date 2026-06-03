import { describe, it, expect } from "vitest";

import { extractTypeScript } from "../../../src/graph/extract/typescript.js";
import { buildSnapshot } from "../../../src/graph/snapshot.js";
import type { GraphMetadata, GraphObservation } from "../../../src/graph/types.js";

function meta(): GraphMetadata {
  return { schema_version: 1, generator: "hivemind-graph", commit_sha: "c", repo_key: "k" };
}
function obs(): GraphObservation {
  return {
    ts: "2026-06-03T00:00:00Z", branch: "main", worktree_path: "/t", repo_project: "t",
    generator_version: "0.0.0-test", source_files_extracted: 0, source_files_skipped: 0,
  };
}

/**
 * B7: JavaScript/JSX are extracted by the same tree-sitter pipeline (TS is a
 * superset). Only the reported `language` differs.
 */
describe("JavaScript / JSX extraction (B7)", () => {
  it("labels .js nodes as javascript and still extracts functions + intra-file calls", () => {
    const ex = extractTypeScript(
      `export function run() { return helper(); }\nfunction helper() { return 1; }\n`,
      "src/a.js",
    );
    expect(ex.language).toBe("javascript");
    const run = ex.nodes.find((n) => n.id === "src/a.js:run:function")!;
    expect(run).toBeDefined();
    expect(run.language).toBe("javascript");
    expect(ex.edges.some((e) => e.relation === "calls" && e.source === "src/a.js:run:function" && e.target === "src/a.js:helper:function")).toBe(true);
  });

  it("parses JSX in a .jsx file without parse errors", () => {
    const ex = extractTypeScript(
      `export function App() { return <div>hi</div>; }\n`,
      "src/App.jsx",
    );
    expect(ex.language).toBe("javascript");
    expect(ex.parse_errors).toHaveLength(0);
    expect(ex.nodes.some((n) => n.id === "src/App.jsx:App:function")).toBe(true);
  });

  it("resolves cross-file calls between .js files", () => {
    const a = extractTypeScript(`import { greet } from "./b";\nexport function run() { return greet(); }\n`, "src/a.js");
    const b = extractTypeScript(`export function greet() { return "hi"; }\n`, "src/b.js");
    const snap = buildSnapshot([a, b], meta(), obs());
    const cross = snap.links.find(
      (e) => e.relation === "calls" && e.source === "src/a.js:run:function" && e.target === "src/b.js:greet:function",
    );
    expect(cross).toBeDefined();
  });

  it("keeps TypeScript files labeled typescript", () => {
    const ex = extractTypeScript(`export function f(): void {}\n`, "src/a.ts");
    expect(ex.language).toBe("typescript");
    expect(ex.nodes.every((n) => n.language === "typescript")).toBe(true);
  });
});
