import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the pure helper functions exported from cold-start-brief.ts.
 * Mocks node:fs so pickColdStartBrief's state/filesystem paths are testable
 * offline. The pure functions (parseTs, cleanSnippet, stripDanglingOpener,
 * deriveProjectLabel, parseUserRows, pickSignal, renderBrief) are exercised
 * directly to maximise branch coverage without touching real disk.
 */

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0, mtime: new Date(0) })),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => "{}"),
    openSync: vi.fn(() => 1),
    readSync: vi.fn(() => 0),
    closeSync: vi.fn(),
  };
});

import {
  parseTs,
  cleanSnippet,
  stripDanglingOpener,
  deriveProjectLabel,
  parseUserRows,
  pickSignal,
  renderBrief,
  pickColdStartBrief,
} from "../../src/notifications/sources/cold-start-brief.js";

// ─── parseTs ────────────────────────────────────────────────────────────────
describe("parseTs", () => {
  it("parses a valid ISO string", () => {
    const d = parseTs("2026-01-15T10:00:00.000Z");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2026-01-15T10:00:00.000Z");
  });

  it("returns null for an invalid string", () => {
    expect(parseTs("not-a-date")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseTs(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTs("")).toBeNull();
  });
});

// ─── stripDanglingOpener ─────────────────────────────────────────────────────
describe("stripDanglingOpener", () => {
  it("removes an unclosed parenthesis", () => {
    expect(stripDanglingOpener("fix the bug (see issue")).toBe("fix the bug");
  });

  it("leaves balanced parentheses intact", () => {
    expect(stripDanglingOpener("fix the bug (now closed)")).toBe("fix the bug (now closed)");
  });

  it("trims trailing punctuation", () => {
    expect(stripDanglingOpener("hello,")).toBe("hello");
  });

  it("returns empty string unchanged", () => {
    expect(stripDanglingOpener("")).toBe("");
  });
});

// ─── cleanSnippet ───────────────────────────────────────────────────────────
describe("cleanSnippet", () => {
  it("returns short strings unchanged (after noise strip)", () => {
    expect(cleanSnippet("fix the auth bug")).toBe("fix the auth bug");
  });

  it("strips markdown noise characters", () => {
    expect(cleanSnippet("**bold** and `code`")).toBe("bold and code");
  });

  it("truncates at a sentence boundary when possible", () => {
    // sentenceEnd (14) must be >= maxLen * 0.5; use maxLen=20 so 14 >= 10.
    const long = "First sentence. Second sentence that is quite long and goes on.";
    const result = cleanSnippet(long, 20);
    expect(result).toBe("First sentence.");
  });

  it("truncates at a clause boundary when no sentence fits", () => {
    const long = "First clause part, second clause part that exceeds limit";
    const result = cleanSnippet(long, 30);
    expect(result.endsWith("…")).toBe(true);
    expect(result.includes(",")).toBe(false); // comma was the cut point
  });

  it("truncates at a word boundary as last resort", () => {
    const long = "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLM"; // no punctuation
    const result = cleanSnippet(long, 30);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(32); // cut + ellipsis
  });

  it("strips leading quote and converts trailing quote", () => {
    // ^["'\s]+ strips the opening ", then " → ' converts the closing one.
    expect(cleanSnippet('"quoted text"')).toBe("quoted text'");
  });

  it("collapses internal whitespace", () => {
    expect(cleanSnippet("too   many   spaces")).toBe("too many spaces");
  });
});

// ─── deriveProjectLabel ──────────────────────────────────────────────────────
describe("deriveProjectLabel", () => {
  it("uses the last path segment from cwdSeen when provided", () => {
    expect(deriveProjectLabel("hashed-dir", "/home/user/myproject")).toBe("myproject");
  });

  it("uses the last dash-segment from projDirName when cwdSeen is absent", () => {
    expect(deriveProjectLabel("home-user-myproject", undefined)).toBe("myproject");
  });

  it("returns projDirName verbatim when there are no dashes and no cwd", () => {
    expect(deriveProjectLabel("nodashes", undefined)).toBe("nodashes");
  });

  it("handles Windows-style backslash paths in cwdSeen", () => {
    expect(deriveProjectLabel("x", "C:\\Users\\user\\project")).toBe("project");
  });
});

// ─── parseUserRows ───────────────────────────────────────────────────────────
describe("parseUserRows", () => {
  function row(content: string, ts = "2026-01-01T10:00:00.000Z", cwd?: string) {
    return JSON.stringify({ type: "user", message: { content }, timestamp: ts, cwd });
  }

  it("parses a valid user row", () => {
    const rows = parseUserRows(row("hello"));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("hello");
    expect(rows[0].ts).toBeInstanceOf(Date);
  });

  it("skips rows that are not type='user'", () => {
    const assistant = JSON.stringify({ type: "assistant", message: { content: "hi" }, timestamp: "2026-01-01T10:00:00.000Z" });
    expect(parseUserRows(assistant)).toHaveLength(0);
  });

  it("skips sidechain rows", () => {
    const sc = JSON.stringify({ type: "user", isSidechain: true, message: { content: "hi" }, timestamp: "2026-01-01T10:00:00.000Z" });
    expect(parseUserRows(sc)).toHaveLength(0);
  });

  it("skips rows with non-string content", () => {
    const bad = JSON.stringify({ type: "user", message: { content: [{ text: "hi" }] }, timestamp: "2026-01-01T10:00:00.000Z" });
    expect(parseUserRows(bad)).toHaveLength(0);
  });

  it("skips rows with an invalid timestamp", () => {
    expect(parseUserRows(row("hi", "not-a-date"))).toHaveLength(0);
  });

  it("skips malformed JSON lines without throwing", () => {
    expect(parseUserRows("{broken json")).toHaveLength(0);
  });

  it("skips empty lines", () => {
    expect(parseUserRows("\n\n")).toHaveLength(0);
  });

  it("carries the cwd field when present", () => {
    const rows = parseUserRows(row("hi", "2026-01-01T10:00:00.000Z", "/my/project"));
    expect(rows[0].cwd).toBe("/my/project");
  });

  it("parses multiple rows from a multi-line chunk", () => {
    const chunk = [row("first"), row("second", "2026-01-01T11:00:00.000Z")].join("\n");
    expect(parseUserRows(chunk)).toHaveLength(2);
  });
});

// ─── pickSignal ──────────────────────────────────────────────────────────────
describe("pickSignal", () => {
  const ts = (offset = 0) => new Date(Date.now() - offset * 3_600_000);

  function session(opts: {
    project?: string;
    firstMessage?: string;
    lastMessage?: string;
    firstTsOffset?: number;
    lastTsOffset?: number;
  } = {}) {
    return {
      project: opts.project ?? "myproj",
      firstTs: ts(opts.firstTsOffset ?? 24),
      lastTs: ts(opts.lastTsOffset ?? 1),
      firstMessage: opts.firstMessage,
      lastMessage: opts.lastMessage,
    };
  }

  it("returns quiet when given no sessions", () => {
    expect(pickSignal([])).toMatchObject({ kind: "quiet" });
  });

  it("returns quiet when sessions are spread across enough projects (no dominant one)", () => {
    // 3 sessions on 3 different projects: none >= 50%, no recall/abandon triggers.
    const sessions = [
      session({ project: "alpha" }),
      session({ project: "beta" }),
      session({ project: "gamma" }),
    ];
    expect(pickSignal(sessions)).toMatchObject({ kind: "quiet" });
  });

  it("returns recall when enough sessions open with recall-seeking phrases", () => {
    const sessions = Array.from({ length: 3 }, (_, i) =>
      session({ project: "p", firstMessage: `what was I doing on task ${i}?` }),
    );
    expect(pickSignal(sessions)).toMatchObject({ kind: "recall", project: "p" });
  });

  it("returns abandoned when last message contains a handoff phrase", () => {
    const sessions = [
      session({ lastMessage: "next time I need to finish the auth flow" }),
    ];
    expect(pickSignal(sessions)).toMatchObject({ kind: "abandoned" });
  });

  it("returns volume when one project dominates (≥50%)", () => {
    const sessions = [
      session({ project: "main" }),
      session({ project: "main" }),
      session({ project: "main" }),
      session({ project: "other" }),
    ];
    const sig = pickSignal(sessions);
    expect(sig).toMatchObject({ kind: "volume", project: "main" });
    expect((sig as { count: number }).count).toBe(3);
  });

  it("returns quiet when top project is below 50%", () => {
    const sessions = [
      session({ project: "a" }),
      session({ project: "b" }),
      session({ project: "c" }),
    ];
    expect(pickSignal(sessions)).toMatchObject({ kind: "quiet" });
  });

  it("recall signal includes oneDay when all hits are on the same day", () => {
    const sameDay = "2026-01-15T10:00:00.000Z";
    const sessions = Array.from({ length: 3 }, () =>
      session({ firstMessage: "what was I doing?", firstTsOffset: 0, lastTsOffset: 0 }),
    ).map(s => ({ ...s, firstTs: new Date(sameDay), lastTs: new Date(sameDay) }));
    const sig = pickSignal(sessions) as { kind: string; date?: string };
    expect(sig.kind).toBe("recall");
    expect(sig.date).toBe("2026-01-15");
  });
});

// ─── renderBrief ─────────────────────────────────────────────────────────────
describe("renderBrief", () => {
  const ts = () => new Date();
  const session = { project: "p", firstTs: ts(), lastTs: ts() };

  it("returns authed copy when authed=true and signal is not quiet", () => {
    const result = renderBrief([session], { kind: "recall", description: "x", project: "p", count: 3 }, true);
    expect(result).toBe("I found context from your recent sessions — from now on I'll keep it, so your next session picks up where you left off.");
  });

  it("returns anonymous copy when authed=false and signal is not quiet", () => {
    const result = renderBrief([session], { kind: "recall", description: "x", project: "p", count: 3 }, false);
    expect(result).toBe("I found context from your recent sessions. Sign in to save it, so future sessions start with what you've already learned.");
  });

  it("returns null when signal kind is quiet", () => {
    expect(renderBrief([session], { kind: "quiet", description: "nothing" }, true)).toBeNull();
  });

  it("returns null when sessions list is empty", () => {
    expect(renderBrief([], { kind: "recall", description: "x", project: "p", count: 3 }, true)).toBeNull();
  });
});

// ─── pickColdStartBrief (entry-point paths via mocked fs) ───────────────────
describe("pickColdStartBrief", () => {
  let existsMock: ReturnType<typeof vi.fn>;
  let readdirMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const fs = await import("node:fs");
    existsMock = fs.existsSync as ReturnType<typeof vi.fn>;
    readdirMock = fs.readdirSync as ReturnType<typeof vi.fn>;
    existsMock.mockReturnValue(false);
    readdirMock.mockReturnValue([]);
  });

  it("returns null for authed user with existing state (already onboarded)", async () => {
    existsMock.mockReturnValue(true); // state file exists
    const result = await pickColdStartBrief({ token: "t" } as never);
    expect(result).toBeNull();
  });

  it("returns null for anonymous user with no local history (nothing to mine)", async () => {
    existsMock.mockReturnValue(false); // no state, no projects dir
    const result = await pickColdStartBrief(null);
    expect(result).toBeNull();
  });

  it("returns null when no creds are provided and no history exists", async () => {
    const result = await pickColdStartBrief(undefined);
    expect(result).toBeNull();
  });

  it("returns null (no crash) on unexpected fs errors", async () => {
    existsMock.mockImplementation(() => { throw new Error("disk error"); });
    const result = await pickColdStartBrief({ token: "t" } as never);
    expect(result).toBeNull();
  });
});
