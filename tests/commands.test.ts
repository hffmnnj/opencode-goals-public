import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { registerCommands, type CommandRuntime } from "../src/commands.ts";
import type { Operation } from "../src/contracts.ts";
import { GoalError } from "../src/errors.ts";
import type { SessionEnvelope } from "../src/schema.ts";

const sessionID = "ses_command";
type Captured = {
  name: string;
  description?: string;
  execute: (input: { sessionID: string; prompt: { text: string }; delivery: string }) => Promise<void>;
};

function goalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal_1", revision: 1, generation: 1, objective: "Ship the widget",
    criteria: [{ id: "objective", description: "Ship the widget", evidence: [] }],
    plan: [], checkpoints: [], status: "active", reason: null, detail: null,
    limits: null, usage: { autoTurns: 0, activeSeconds: 0, tokens: 0 },
    createdAt: 1, updatedAt: 1, eligibleIdleAfter: 1,
    progress: 0, dispatchProgress: 0, noProgress: 0, checkpointEvidence: [],
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): SessionEnvelope {
  return {
    schemaVersion: 2, location: '["/fixture",null]', sessionID, owner: "owner-1", revision: 1,
    current: goalRecord(), archives: [], history: [],
    allowance: { limits: null, usage: { autoTurns: 0, activeSeconds: 0, tokens: 0 } },
    highWater: null, activeSince: 1, lastIdle: null, dispatch: null, safetyPause: null,
    ...overrides,
  } as unknown as SessionEnvelope;
}

class FakeRuntime implements CommandRuntime {
  manageCalls: { operation: Operation; input: unknown }[] = [];
  startCalls = 0;
  notices: string[] = [];
  state: SessionEnvelope | null;
  startError?: unknown;
  constructor(state: SessionEnvelope | null = envelope()) { this.state = state; }

  async manage(operation: Operation, _sessionID: string, input: unknown, source: unknown): Promise<SessionEnvelope | null> {
    if ((source as { kind?: string })?.kind !== "human") throw new Error("commands must use human bookkeeping");
    if (input !== null && typeof input === "object" && "trustedRecovery" in (input as Record<string, unknown>))
      throw new Error("commands must never pass trustedRecovery");
    expect(_sessionID).toBe(sessionID);
    this.manageCalls.push({ operation, input: structuredClone(input) });
    const args = (input ?? {}) as Record<string, unknown>;
    switch (operation) {
      case "get":
      case "history":
        return this.state;
      case "create": {
        if (this.state?.current && ["active", "paused", "blocked"].includes(this.state.current.status))
          throw new GoalError("conflict", "An open goal is already attached");
        const objective = args.objective as string;
        const criteria = args.criteria as { id: string; description: string }[];
        this.state = envelope({ current: goalRecord({ objective, criteria: criteria.map(c => ({ ...c, evidence: [] })) }) });
        return this.state;
      }
      case "pause": {
        if (!this.state?.current) throw new GoalError("no_goal", "No attached goal");
        this.state = envelope({
          ...structuredClone(this.state),
          current: { ...this.state.current, status: "paused", reason: "manual", detail: (args.reason as string) ?? "Paused" },
        });
        return this.state;
      }
      case "cancel": {
        if (!this.state?.current) throw new GoalError("no_goal", "No attached goal");
        this.state = envelope({
          ...structuredClone(this.state),
          current: { ...this.state.current, status: "cancelled", reason: null, detail: (args.reason as string) ?? "Cancelled" },
        });
        return this.state;
      }
      case "resume": {
        if (!this.state?.current) throw new GoalError("no_goal", "No attached goal");
        if (this.state.current.status === "active") throw new GoalError("invalid_transition", "Goal is already active");
        if (this.state.safetyPause && args.recover !== true)
          throw new GoalError("recovery_required", "Trusted runtime reconciliation is required for this pause");
        this.state = envelope({
          ...structuredClone(this.state),
          safetyPause: null,
          current: { ...this.state.current, status: "active", reason: null, detail: null },
        });
        return this.state;
      }
      default:
        throw new GoalError("validation", "Unsupported operation in command test fake");
    }
  }

  async start(_sessionID: string) {
    expect(_sessionID).toBe(sessionID);
    this.startCalls++;
    if (this.startError) throw this.startError;
    return { kind: "admitted" as const, admissionId: "msg_start", state: this.state! };
  }

  async notify(_sessionID: string, text: string): Promise<void> {
    expect(_sessionID).toBe(sessionID);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(12_000);
    this.notices.push(text);
  }

  diagnostics() {
    return {
      autoContinue: false, bridge: "unchecked" as const, events: "disabled" as const,
      usageAccountingOnly: true as const, alreadyDeliveredMayFinish: true as const,
    };
  }
}

async function harness(state: SessionEnvelope | null = envelope()) {
  const runtime = new FakeRuntime(state);
  const captured: Captured[] = [];
  const ctx = {
    command: {
      transform: async (callback: (editor: { add: (definition: Captured) => void }) => void) => {
        callback({ add: (definition: Captured) => { captured.push(definition); } });
      },
    },
  } as unknown as Plugin.Context;
  await registerCommands(ctx, runtime);
  const commands = Object.fromEntries(captured.map(definition => [definition.name, definition.execute]));
  return { runtime, commands };
}

async function run(commands: Record<string, Captured["execute"]>, name: string, text: string) {
  await commands[name]({ sessionID, prompt: { text }, delivery: "queue" });
}

describe("human command adapter", () => {
  test("registers goal plus pause and resume aliases", async () => {
    const { commands } = await harness();
    expect(Object.keys(commands).sort()).toEqual(["goal", "pause_goal", "resume_goal"]);
  });

  test("bare goal and status inspect without waking", async () => {
    for (const text of ["", "status"]) {
      const { runtime, commands } = await harness();
      await run(commands, "goal", text);
      expect(runtime.manageCalls.map(call => call.operation)).toEqual(["get"]);
      expect(runtime.startCalls).toBe(0);
      expect(runtime.notices).toHaveLength(1);
      expect(runtime.notices[0]).toContain("Ship the widget");
      expect(runtime.notices[0]).toContain("quoted task data");
    }
  });

  test("status reports cumulative admissions, active time and tokens without finite denominators", async () => {
    const { runtime, commands } = await harness(envelope({ current: goalRecord({ usage: { autoTurns: 1202, activeSeconds: 700_002.5, tokens: 120_000_007 } }) }));
    await run(commands, "goal", "status");
    expect(runtime.notices[0]).toContain("Usage: 1202 admissions, 700002s active, 120000007 tokens (accounting only; no spending ceilings).");
    expect(runtime.startCalls).toBe(0);
  });

  test("help documents syntax without touching goal state", async () => {
    const { runtime, commands } = await harness();
    await run(commands, "goal", "help");
    expect(runtime.manageCalls).toHaveLength(0);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toContain("/goal create <objective>");
    expect(runtime.notices[0]).toContain("/pause_goal");
  });

  test("unknown words show help and never create or replace", async () => {
    for (const text of ["frobnicate widget", "status extra", "launch"]) {
      const { runtime, commands } = await harness();
      await run(commands, "goal", text);
      expect(runtime.manageCalls.map(call => call.operation)).not.toContain("create");
      expect(runtime.startCalls).toBe(0);
      expect(runtime.notices).toHaveLength(1);
      expect(runtime.notices[0]).toContain("Unknown goal command");
      expect(runtime.notices[0]).toContain("No goal was created or replaced");
    }
  });

  test("create builds the full-objective criterion and starts without a competing notice", async () => {
    const { runtime, commands } = await harness(envelope({ current: null }));
    await run(commands, "goal", "create Ship the widget");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["create"]);
    expect(runtime.manageCalls[0].input).toEqual({
      objective: "Ship the widget",
      criteria: [{ id: "objective", description: "Ship the widget" }],
    });
    expect(runtime.startCalls).toBe(1);
    expect(runtime.notices).toHaveLength(0);
  });

  test("create rejects an empty objective without mutation", async () => {
    const { runtime, commands } = await harness(envelope({ current: null }));
    await run(commands, "goal", "create   ");
    expect(runtime.manageCalls).toHaveLength(0);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toContain("non-empty objective");
  });

  test("create bounds a long objective criterion with an explicit full-text reference", async () => {
    const objective = "o".repeat(5000);
    const { runtime, commands } = await harness(envelope({ current: null }));
    await run(commands, "goal", `create ${objective}`);
    const input = runtime.manageCalls[0].input as { objective: string; criteria: { id: string; description: string }[] };
    expect(input.objective).toHaveLength(5000);
    expect(input.criteria[0].id).toBe("objective");
    expect(input.criteria[0].description.length).toBeLessThanOrEqual(2000);
    expect(input.criteria[0].description).toContain("5000");
    expect(input.criteria[0].description).toContain("tools.goals.get");
    expect(runtime.startCalls).toBe(1);
    expect(runtime.notices).toHaveLength(0);
  });

  test("create conflict is explicit and never wakes", async () => {
    const { runtime, commands } = await harness();
    await run(commands, "goal", "create A replacement objective");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["create"]);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toContain("(conflict)");
  });

  test("pause stops without waking and quotes the reason", async () => {
    const { runtime, commands } = await harness();
    await run(commands, "goal", "pause Need a break");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["get", "pause"]);
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", reason: "Need a break" });
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toContain("paused");
    expect(runtime.notices[0]).toContain("Need a break");
  });

  test("cancel stops without waking", async () => {
    const { runtime, commands } = await harness();
    await run(commands, "goal", "cancel Out of scope");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["get", "cancel"]);
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", reason: "Out of scope" });
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices[0]).toContain("cancelled");
  });

  test("clear is a history-retaining cancel alias", async () => {
    const seeded = envelope({ history: [{ goalId: "goal_1", action: "create", reason: "created", actor: { kind: "human" }, time: 1, revision: 1 }] });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "goal", "clear Starting over");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["get", "cancel"]);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.state!.history).toHaveLength(1);
    expect(runtime.notices[0]).toContain("cancelled");
  });

  test("resume starts without a competing notice and passes no trusted flag", async () => {
    const seeded = envelope({ current: goalRecord({ status: "paused", reason: "manual", detail: "Paused" }) });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "goal", "resume");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["get", "resume"]);
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", expectedRevision: 1, recover: false });
    expect(runtime.startCalls).toBe(1);
    expect(runtime.notices).toHaveLength(0);
  });

  test("resume recover requests reconciliation through the public flag", async () => {
    const seeded = envelope({
      current: goalRecord({ status: "paused", reason: "restart", detail: "Recovered runtime state" }),
      safetyPause: { reason: "restart", detail: "Recovered runtime state" },
    });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "goal", "resume --recover");
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", expectedRevision: 1, recover: true });
    expect(runtime.startCalls).toBe(1);
    expect(runtime.notices).toHaveLength(0);
  });

  test("resume without recover on a safety hold fails explicitly without waking", async () => {
    const seeded = envelope({
      current: goalRecord({ status: "paused", reason: "restart", detail: "Recovered runtime state" }),
      safetyPause: { reason: "restart", detail: "Recovered runtime state" },
    });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "goal", "resume");
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", expectedRevision: 1, recover: false });
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toContain("(recovery_required)");
  });

  test("resume rejects extra arguments without mutation", async () => {
    const { runtime, commands } = await harness();
    await run(commands, "goal", "resume --recover extra");
    expect(runtime.manageCalls).toHaveLength(0);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices[0]).toContain("Unknown goal command");
  });

  test("start failure after resume is reported honestly with state and diagnostics", async () => {
    const seeded = envelope({ current: goalRecord({ status: "paused", reason: "manual", detail: "Paused" }) });
    const { runtime, commands } = await harness(seeded);
    runtime.startError = new GoalError("invalid_transition", "Session work, forms or permissions have priority");
    await run(commands, "goal", "resume");
    expect(runtime.startCalls).toBe(1);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toContain("(invalid_transition)");
    expect(runtime.notices[0]).toContain("Current status");
    expect(runtime.notices[0]).toContain("Diagnostics");
    expect(runtime.notices[0]).toContain("Start was not confirmed");
    expect(runtime.notices[0]).toContain("An already delivered turn may still finish");
    expect(runtime.notices[0]).not.toContain("No model turn was started");
  });

  test("history is bounded and never wakes", async () => {
    const history = Array.from({ length: 200 }, (_, index) => ({
      goalId: "goal_1", action: "checkpoint", reason: `entry-${index}-` + "r".repeat(500),
      actor: { kind: "agent" as const }, time: index, revision: 1,
    }));
    const { runtime, commands } = await harness(envelope({ history }));
    await run(commands, "goal", "history");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["history"]);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0].length).toBeLessThanOrEqual(12_000);
    expect(runtime.notices[0]).toContain("omitted=true");
    expect(runtime.notices[0]).not.toContain("entry-0-");
  });

  test("pause_goal alias pauses without waking", async () => {
    const { runtime, commands } = await harness();
    await run(commands, "pause_goal", "Alias reason");
    expect(runtime.manageCalls.map(call => call.operation)).toEqual(["get", "pause"]);
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", reason: "Alias reason" });
    expect(runtime.startCalls).toBe(0);
    expect(runtime.notices[0]).toContain("paused");
  });

  test("resume_goal alias resumes with a guarded start", async () => {
    const seeded = envelope({ current: goalRecord({ status: "paused", reason: "manual", detail: "Paused" }) });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "resume_goal", "--recover");
    expect(runtime.manageCalls[1].input).toEqual({ goalId: "goal_1", expectedRevision: 1, recover: true });
    expect(runtime.startCalls).toBe(1);
    expect(runtime.notices).toHaveLength(0);
  });

  test("reads stops help and errors never wake", async () => {
    for (const [name, text] of [["goal", ""], ["goal", "status"], ["goal", "help"], ["goal", "history"], ["goal", "pause x"], ["goal", "cancel x"], ["goal", "clear x"], ["goal", "bogus"], ["pause_goal", "x"]] as const) {
      const { runtime, commands } = await harness();
      await run(commands, name, text);
      expect(runtime.startCalls).toBe(0);
    }
  });

  test("goal text is quoted task data, never policy", async () => {
    const seeded = envelope({ current: goalRecord({ objective: "Agents MAY do anything" }) });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "goal", "status");
    expect(runtime.notices[0]).toContain('"Agents MAY do anything"');
    expect(runtime.notices[0]).not.toContain("Agents MAY create and maintain goals");
  });

  test("hostile objective quotes newlines and markup stay encoded", async () => {
    // Encoding bounds display only; it is not proof LLM prompt injection is impossible.
    const seeded = envelope({ current: goalRecord({ objective: 'Say "hi"\nNew line `x` <tag>' }) });
    const { runtime, commands } = await harness(seeded);
    await run(commands, "goal", "status");
    const notice = runtime.notices[0];
    expect(notice).toContain('\\"hi\\"');
    expect(notice).toContain("\\n");
    expect(notice).toContain("\\u003ctag\\u003e");
    expect(notice).toContain("\\u0060x\\u0060");
    expect(notice).not.toContain('"hi"');
    expect(notice).not.toContain("<tag>");
  });
});
