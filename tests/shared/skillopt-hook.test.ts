import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/skillify/skillopt-trigger.js", () => ({
  markSkillPending: vi.fn(() => true),
  runEventTrigger: vi.fn(() => ({ fired: true, reason: "spawned" })),
}));

import { markSkillPending, runEventTrigger } from "../../src/skillify/skillopt-trigger.js";
import { armSkillOptOnSkillUse, reactSkillOpt } from "../../src/hooks/shared/skillopt-hook.js";

beforeEach(() => { vi.clearAllMocks(); delete process.env.HIVEMIND_SKILLOPT_DISABLED; delete process.env.HIVEMIND_WIKI_WORKER; });

describe("armSkillOptOnSkillUse", () => {
  it("arms on a Skill tool_use, passing the skill ref", () => {
    armSkillOptOnSkillUse("s1", "Skill", { skill: "posthog--kamo" });
    expect(markSkillPending).toHaveBeenCalledWith("s1", "posthog--kamo");
  });
  it("does nothing for non-Skill tools", () => {
    armSkillOptOnSkillUse("s1", "Bash", { command: "ls" });
    expect(markSkillPending).not.toHaveBeenCalled();
  });
  it("does nothing when disabled, or when the input has no skill string", () => {
    process.env.HIVEMIND_SKILLOPT_DISABLED = "1";
    armSkillOptOnSkillUse("s1", "Skill", { skill: "posthog--kamo" });
    delete process.env.HIVEMIND_SKILLOPT_DISABLED;
    armSkillOptOnSkillUse("s1", "Skill", {});
    expect(markSkillPending).not.toHaveBeenCalled();
  });
});

describe("reactSkillOpt", () => {
  it("fires the trigger with the prompt as the reaction + the agent", () => {
    reactSkillOpt("s1", "no you fucked up", "codex");
    expect(runEventTrigger).toHaveBeenCalledWith("s1", "no you fucked up", { agent: "codex" });
  });
  it("does nothing when there is no prompt (not a UserPromptSubmit)", () => {
    reactSkillOpt("s1", undefined, "codex");
    expect(runEventTrigger).not.toHaveBeenCalled();
  });
  it("does nothing inside an internal worker call (HIVEMIND_WIKI_WORKER=1)", () => {
    process.env.HIVEMIND_WIKI_WORKER = "1";
    reactSkillOpt("s1", "hi", "claude_code");
    expect(runEventTrigger).not.toHaveBeenCalled();
  });
});
