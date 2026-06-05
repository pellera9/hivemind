import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { extractMemoryOp } from "../../src/path-match.js";

const HOME = homedir();
const MEM = `${HOME}/.deeplake/memory`;

describe("extractMemoryOp", () => {
  describe("Read", () => {
    it("returns read op when file_path starts with memoryPath", () => {
      const op = extractMemoryOp("Read", { file_path: `${MEM}/foo.md` }, MEM);
      expect(op).toEqual({ path: `${MEM}/foo.md`, op: "read" });
    });

    it("returns null when file_path is outside memoryPath", () => {
      expect(extractMemoryOp("Read", { file_path: "/tmp/other.md" }, MEM)).toBeNull();
    });

    it("expands tilde in file_path", () => {
      const op = extractMemoryOp("Read", { file_path: "~/.deeplake/memory/foo.md" }, MEM);
      expect(op?.op).toBe("read");
      expect(op?.path).toBe(`${HOME}/.deeplake/memory/foo.md`);
    });

    it("returns null when file_path is absent", () => {
      expect(extractMemoryOp("Read", {}, MEM)).toBeNull();
    });
  });

  describe("Write", () => {
    it("returns write op for a matching path", () => {
      expect(extractMemoryOp("Write", { file_path: `${MEM}/x.md` }, MEM))
        .toEqual({ path: `${MEM}/x.md`, op: "write" });
    });

    it("returns null for a non-matching path", () => {
      expect(extractMemoryOp("Write", { file_path: "/home/user/other.md" }, MEM)).toBeNull();
    });
  });

  describe("Edit", () => {
    it("returns edit op for a matching path", () => {
      expect(extractMemoryOp("Edit", { file_path: `${MEM}/a.md` }, MEM))
        .toEqual({ path: `${MEM}/a.md`, op: "edit" });
    });
  });

  describe("Glob", () => {
    it("returns list op when path matches", () => {
      expect(extractMemoryOp("Glob", { path: `${MEM}/**` }, MEM))
        .toEqual({ path: `${MEM}/**`, op: "list" });
    });

    it("returns null when path is outside memory", () => {
      expect(extractMemoryOp("Glob", { path: "/tmp/**" }, MEM)).toBeNull();
    });
  });

  describe("Grep", () => {
    it("returns search op when path matches", () => {
      expect(extractMemoryOp("Grep", { path: MEM }, MEM))
        .toEqual({ path: MEM, op: "search" });
    });

    it("returns null when path is outside memory", () => {
      expect(extractMemoryOp("Grep", { path: "/tmp" }, MEM)).toBeNull();
    });
  });

  describe("Bash", () => {
    it("returns bash op when command contains the expanded memoryPath", () => {
      const op = extractMemoryOp("Bash", { command: `cat ${MEM}/foo.md` }, MEM);
      expect(op).toEqual({ path: MEM, op: "bash" });
    });

    it("returns bash op when command contains the literal ~/.deeplake/memory sentinel", () => {
      const op = extractMemoryOp("Bash", { command: "cat ~/.deeplake/memory/foo.md" }, MEM);
      expect(op).toEqual({ path: MEM, op: "bash" });
    });

    it("returns null when command does not reference memory", () => {
      expect(extractMemoryOp("Bash", { command: "ls /tmp" }, MEM)).toBeNull();
    });

    it("returns null when command is absent", () => {
      expect(extractMemoryOp("Bash", {}, MEM)).toBeNull();
    });
  });

  describe("unknown tool", () => {
    it("returns null for unrecognised tool names", () => {
      expect(extractMemoryOp("Unknown", { file_path: MEM }, MEM)).toBeNull();
    });
  });

  describe("tilde expansion in memoryPath", () => {
    it("expands tilde in the memoryPath argument itself", () => {
      const op = extractMemoryOp("Read", { file_path: `${HOME}/.deeplake/memory/x.md` }, "~/.deeplake/memory");
      expect(op).toEqual({ path: `${HOME}/.deeplake/memory/x.md`, op: "read" });
    });
  });
});
