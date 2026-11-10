import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { GoalRuntime } from "../src/runtime.ts";
import type { ServerBridge } from "../src/bridge.ts";
import type { NativeHost, NativeSession } from "../src/native.ts";
import type { RuntimeOwner } from "../src/ownership.ts";
import { PublicResultSchema, RPCSchemas, ToolSchemas } from "../src/contracts.ts";
import { GoalsRPC, registerRPC } from "../src/rpc.ts";
import { registerTools } from "../src/tools.ts";
import type { GoalStorage } from "../src/service.ts";

const EXPECTED_OPERATIONS = [
  "block", "cancel", "checkpoint", "complete", "create", "evidence",
  "get", "history", "pause", "plan", "resume", "revise",
].sort();
const sessionID = "ses_rpc_surface";
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const agentSource = { kind: "agent" as const, agent: "build" };
const createInput = {
  objective: "Deliver authorized behavior",
  criteria: [{ id: "accept", description: "The behavior is verified" }],
};

class Store implements GoalStorage {
  values = new Map<string, Parameters<GoalStorage["set"]>[1]>();
  async get(key: string) { return structuredClone(this.values.get(key)); }
  async set(key: string, value: Parameters<GoalStorage["set"]>[1]) {
    this.values.set(key, structuredClone(value));
  }
}
class Owner implements RuntimeOwner {
  token = "00000000-0000-4000-8000-000000000002"; held = true;
  async assertOwned() { if (!this.held) throw new Error("Ownership lost"); }
  async release() { this.held = false; }
}
class Bridge implements ServerBridge {
  promptAttempts = 0;
  serverIdentity() { return "legacy"; }
  async verify() {}
  async inspect() { return { active: false, inbox: [], forms: [] }; }
  async background() { return { shells: [], children: [] }; }
  async cancel() {}
  async defaultAgent() { return "build"; }
}
class Host implements NativeHost {
  location = { directory: "/fixture/rpc-surface" };
  session: NativeSession = {
    id: sessionID, location: this.location, agent: "build",
    tokens: structuredClone(tokens), permissions: [],
  };
  constructor(readonly bridge: Bridge) {}
  async getSession() { return structuredClone(this.session); }
  async context() { return []; }
  async wait(_id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  }
  async getAgent(id: string) { return { id, mode: "primary", permissions: [] }; }
  async permissions() { return []; }
  async prompt(_sessionID: string, admission: { id: string }) {
    this.bridge.promptAttempts++;
    return { id: admission.id };
  }
  async notify() {}
  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

function fixture() {
  const bridge = new Bridge(); const host = new Host(bridge); const owner = new Owner();
  let n = 0;
  const runtime = new GoalRuntime({
    host, bridge, owner, storage: new Store(), options: { autoContinue: true },
    now: () => 10_000, uuid: () => `00000000-0000-4000-8000-${String(++n + 20).padStart(12, "0")}`,
  });
  runtime.startObserving();
  return { runtime, bridge };
}

type Handler = (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
async function registered() {
  const f = fixture();
  let handlers: Record<string, Handler> = {};
  const tools: string[] = [];
  const ctx = {
    tool: { transform: async (edit: (editor: unknown) => void) => edit({ namespace() {}, add(tool: { name: string }) { tools.push(tool.name); } }) },
    rpc: { register: async (definition: { id: string; events: unknown }, callbacks: Record<string, Handler>) => {
      expect(definition.id).toBe("goals");
      expect(definition.events).toEqual({});
      handlers = callbacks;
    } },
  } as unknown as Plugin.Context;
  await registerTools(ctx, f.runtime);
  await registerRPC(ctx, f.runtime);
  return { ...f, handlers, tools };
}

function okResult(value: unknown) {
  expect(PublicResultSchema.safeParse(value).success).toBe(true);
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) {
    throw new Error("Test requires a successful result");
  }
  return value as Extract<import("../src/contracts.ts").PublicResult, { ok: true }>;
}

describe("goals-only public RPC surface", () => {
  test("advertised methods and tools expose exactly the twelve lifecycle operations", () => {
    const methods = GoalsRPC.methods as unknown as Record<string, { input: unknown; output: unknown }>;
    expect(GoalsRPC.id).toBe("goals");
    expect(Object.keys(methods).sort()).toEqual(EXPECTED_OPERATIONS);
    expect("snapshot" in methods).toBe(false);
    expect(Object.keys(ToolSchemas).sort()).toEqual(EXPECTED_OPERATIONS);
    for (const operation of EXPECTED_OPERATIONS) {
      expect(methods[operation].input).toBe(RPCSchemas[operation as keyof typeof RPCSchemas]);
      expect(methods[operation].output).toBe(PublicResultSchema);
    }
  });

  test("registered handlers are exactly the twelve operations and run real lifecycle behavior", async () => {
    const f = await registered();
    try {
      expect(f.tools.sort()).toEqual(EXPECTED_OPERATIONS);
      expect(Object.keys(f.handlers).sort()).toEqual(EXPECTED_OPERATIONS);
      expect("snapshot" in f.handlers).toBe(false);
      const signal = new AbortController().signal;

      const created = okResult(await f.handlers.create({ ...createInput, sessionID }, { signal }));
      expect(created.current).toMatchObject({ view: "summary", revision: 1 });
      const goalId = created.current!.id;
      expect(goalId.startsWith("goal_")).toBe(true);

      const planned = okResult(await f.handlers.plan({
        sessionID, goalId, expectedRevision: 1,
        steps: [{ id: "a", description: "First step", status: "pending" }], reason: "Initial plan",
      }, { signal }));
      expect(planned.current).toMatchObject({ id: goalId, revision: 2 });

      // A stale revision is fenced against real stored state: a no-op stub
      // returning canned success could never reject this.
      expect(await f.handlers.revise({ sessionID, goalId, expectedRevision: 1, reason: "Stale rewrite" }, { signal }))
        .toMatchObject({ ok: false });

      const evidenced = okResult(await f.handlers.evidence({
        sessionID, goalId, expectedRevision: 2,
        criterionId: "accept", evidence: { summary: "Focused check passed" },
      }, { signal }));
      expect(evidenced.current).toMatchObject({ id: goalId, revision: 3 });
      // Unknown criteria are rejected by the real service, not silently accepted.
      expect(await f.handlers.evidence({
        sessionID, goalId, expectedRevision: 3,
        criterionId: "missing", evidence: { summary: "Nothing verified" },
      }, { signal })).toMatchObject({ ok: false });

      const got = okResult(await f.handlers.get({ sessionID }, { signal }));
      expect(got.current).toMatchObject({ view: "full", id: goalId, revision: 3 });

      // The removed board-only operation has no handler and no runtime path.
      expect(await f.runtime.call("snapshot" as never, sessionID, { sessionID }, agentSource))
        .toMatchObject({ ok: false, error: { code: "validation" } });
      expect(f.bridge.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("RPC inputs carry only lifecycle fields and reject trusted or envelope-smuggling fields", () => {
    const valid: Record<keyof typeof RPCSchemas, Record<string, unknown>> = {
      get: { sessionID }, history: { sessionID },
      create: { ...createInput, sessionID },
      revise: { sessionID, goalId: "goal_a", expectedRevision: 1, reason: "Clarify scope" },
      plan: { sessionID, goalId: "goal_a", expectedRevision: 1, steps: [], reason: "Initial plan" },
      evidence: { sessionID, goalId: "goal_a", expectedRevision: 1, criterionId: "accept", evidence: { summary: "Observed real check" } },
      checkpoint: { sessionID, goalId: "goal_a", expectedRevision: 1, summary: "Current progress" },
      complete: { sessionID, goalId: "goal_a", expectedRevision: 1, summary: "Verified all work" },
      block: { sessionID, goalId: "goal_a", expectedRevision: 1, blocker: "Account unavailable" },
      pause: { sessionID, goalId: "goal_a", expectedRevision: 1 },
      cancel: { sessionID, goalId: "goal_a", expectedRevision: 1 },
      resume: { sessionID, goalId: "goal_a", expectedRevision: 1 },
    };
    for (const operation of EXPECTED_OPERATIONS) {
      const schema = RPCSchemas[operation as keyof typeof RPCSchemas];
      expect(schema.safeParse(valid[operation as keyof typeof valid]).success).toBe(true);
      for (const field of ["actor", "trustedRecovery", "tokens", "executionAllowed", "owner", "explicitStop", "commandStart"]) {
        expect(schema.safeParse({ ...valid[operation as keyof typeof valid], [field]: true }).success).toBe(false);
      }
    }
  });
});
