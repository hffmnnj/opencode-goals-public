import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { GoalRuntime } from "../src/runtime.ts";
import { BridgeError, type BridgeSnapshot, type ServerBridge, type BackgroundSnapshot } from "../src/bridge.ts";
import type { Admission, NativeHost, NativeMessage, NativeSession } from "../src/native.ts";
import { executionPolicy, nativeHost } from "../src/native.ts";
import type { RuntimeOwner } from "../src/ownership.ts";
import { ToolSchemas, RPCSchemas, PublicResultSchema, POLICY } from "../src/contracts.ts";
import { registerTools } from "../src/tools.ts";
import { registerRPC, GoalsRPC } from "../src/rpc.ts";
import type { GoalStorage } from "../src/service.ts";
import type { SessionEnvelope } from "../src/schema.ts";
import { legacyEnvelope } from "./fixtures/legacy-envelope.ts";

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const input = { objective: "Deliver authorized behavior", criteria: [{ id: "accept", description: "The behavior is verified" }] };
const sessionID = "ses_native";
const agentSource = { kind: "agent" as const, agent: "build" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
class Store implements GoalStorage {
  values = new Map<string, Parameters<GoalStorage["set"]>[1]>();
  onWrite?: (value: unknown) => void;
  beforeWrite?: (value: SessionEnvelope) => Promise<void>;
  beforeRead?: () => Promise<void>;
  async get(key: string) { const value = structuredClone(this.values.get(key)); await this.beforeRead?.(); return value; }
  async set(key: string, value: Parameters<GoalStorage["set"]>[1]) { await this.beforeWrite?.(value as SessionEnvelope); this.values.set(key, structuredClone(value)); this.onWrite?.(value); }
}
class Owner implements RuntimeOwner {
  token = "00000000-0000-4000-8000-000000000001"; held = true; released = false;
  async assertOwned() { if (!this.held) throw new Error("Ownership lost"); }
  async release() { this.released = true; this.held = false; }
}
class Bridge implements ServerBridge {
  state: BridgeSnapshot = { active: false, inbox: [], forms: [] };
  failure?: BridgeError; checks = 0; cancelled: string[] = [];
  beforeInspect?: () => Promise<void>;
  jobs: BackgroundSnapshot = { shells: [], children: [] };
  beforeBackground?: () => Promise<void>;
  beforeCancel?: () => Promise<void>;
  afterCancel?: () => Promise<void>;
  onCancelled?: (sessionID: string, inboxID: string) => void;
  serverIdentity() { return "legacy"; }
  async background() { await this.verify(); const value = structuredClone(this.jobs); await this.beforeBackground?.(); return value; }
  async verify() { this.checks++; if (this.failure) throw this.failure; }
  async inspect() { await this.verify(); const snapshot = structuredClone(this.state); await this.beforeInspect?.(); return snapshot; }
  async cancel(id: string, owned: string) {
    await this.verify(); this.cancelled.push(owned); await this.beforeCancel?.();
    // Native cancellation is conditional: delivery may already have removed the
    // row. Both paths return void/204; only a winning commit publishes an event.
    if (this.state.inbox.some(item => item.id === owned && item.sessionID === id)) {
      this.state.inbox = this.state.inbox.filter(item => item.id !== owned);
      this.onCancelled?.(id, owned);
    }
    await this.afterCancel?.();
  }
  defaultName: string | undefined = "build";
  async defaultAgent() { await this.verify(); return this.defaultName; }
}
class Host implements NativeHost {
  location = { directory: "/fixture/project" };
  session: NativeSession = { id: sessionID, location: this.location, agent: "build", tokens: structuredClone(tokens), permissions: [] };
  messages: NativeMessage[] = [];
  pendingPermissions: unknown[] = [];
  promptAttempts = 0; waitCalls = 0; admitted: Admission[] = []; notices: Admission[] = [];
  beforePrompt?: () => Promise<void>;
  afterGuard?: () => Promise<void>;
  beforeIdle?: (signal: AbortSignal) => Promise<void>;
  beforeAgent?: () => Promise<void>;
  beforeContext?: () => Promise<void>;
  guard?: (admission: Admission) => Promise<void>;
  streamFailure = deferred();
  constructor(readonly bridge: Bridge) {}
  async getSession(_id = sessionID) { return structuredClone(this.session); }
  async context() { const messages = structuredClone(this.messages); await this.beforeContext?.(); return messages; }
  async wait(_id: string, signal: AbortSignal) {
    this.waitCalls++; signal.throwIfAborted();
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([this.beforeIdle?.(signal), aborted]); signal.throwIfAborted(); }
    finally { signal.removeEventListener("abort", abort); }
  }
  async getAgent(id: string) { await this.beforeAgent?.(); return { id, mode: "primary", permissions: [] }; }
  async permissions() { return this.pendingPermissions; }
  async prompt(_sessionID: string, admission: Admission, signal: AbortSignal) {
    this.promptAttempts++;
    await this.beforePrompt?.(); signal.throwIfAborted();
    await this.guard?.(admission);
    await this.afterGuard?.(); signal.throwIfAborted();
    this.admitted.push(admission);
    this.bridge.state.inbox.push({ id: admission.id, sessionID, type: "user", payload: { metadata: admission.metadata }, delivery: "queue", time: { created: 10_000 } });
    return { id: admission.id };
  }
  async notify(_id: string, admission: Admission) {
    this.notices.push(admission);
    this.bridge.state.inbox.push({ id: admission.id, sessionID, type: "synthetic", payload: { metadata: admission.metadata }, delivery: "queue", time: { created: 10_000 } });
  }
  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    await Promise.race([this.streamFailure.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    if (!signal.aborted) throw new Error("Synthetic event source failure");
  }
}
function fixture(autoContinue = true, store = new Store()) {
  const bridge = new Bridge(); const host = new Host(bridge); const owner = new Owner();
  let time = 10_000; let n = 0;
  const runtime = new GoalRuntime({ host, bridge, owner, storage: store, options: { autoContinue }, now: () => time, uuid: () => `00000000-0000-4000-8000-${String(++n + 10).padStart(12, "0")}` });
  host.guard = admission => runtime.guardPrompt({ sessionID, messageID: admission.id, metadata: admission.metadata });
  let sequence = 0;
  const cancellationEvent = (id: string, inboxID: string) => ({
    type: "session.inbox.cancelled", created: time, id: `evt_cancel_${++sequence}`,
    durable: { aggregateID: id, seq: sequence, version: 1 }, data: { sessionID: id, inboxID },
  });
  bridge.onCancelled = (id, inboxID) => runtime.acceptEvent(cancellationEvent(id, inboxID));
  runtime.startObserving();
  // Pinned 2.0.25 execution/usage events have no location; idle is a message, not an event.
  const emit = (type: string) => runtime.acceptEvent({ type, created: time, ...(!type.startsWith("session.execution.") && !type.startsWith("session.usage.") ? { location: host.location } : {}), data: { sessionID } });
  const succeed = () => {
    time += 10; host.session.outcome = "succeeded"; host.session.idleTime = time;
    host.messages.push({ id: `msg_idle_${time}`, type: "idle", created: time, outcome: "succeeded" });
    time += 1; emit("session.execution.succeeded");
  };
  return {
    runtime, bridge, host, owner, store, emit, succeed, cancellationEvent,
    advance(ms = 10) { time += ms; },
    async create() { return (await runtime.manage("create", sessionID, input, agentSource))!; },
    async get() { return (await runtime.manage("get", sessionID, {}, agentSource))!; },
    async begin() { time += 10; emit("session.execution.started"); await runtime.drain(); await runtime.context(sessionID, "build"); },
    async idle() { succeed(); await runtime.drain(); },
  };
}
function target(state: SessionEnvelope) { return { goalId: state.current!.id, expectedRevision: state.current!.revision }; }

async function legacyBudgetHold(f: ReturnType<typeof fixture>, state?: SessionEnvelope) {
  const s = state ?? await f.create();
  const old = legacyEnvelope(s, true);
  old.current!.status = "paused"; old.current!.reason = "budget"; old.current!.detail = "Legacy budget stop";
  old.current!.usage.tokens = 10; old.allowance.usage.tokens = 10;
  old.highWater = { ...tokens, input: 10 }; old.activeSince = null; old.explicitStop = false;
  old.safetyPause = { reason: "budget", detail: "Legacy budget stop" };
  if (old.dispatch) old.dispatch.phase = "invalidated";
  const key = [...f.store.values.keys()][0];
  if (!key) throw new Error("Seed requires an existing durable envelope");
  f.store.values.set(key, old); f.host.session.tokens.input = 10;
  return f.get();
}

describe("native facade and policy", () => {
  test("bookkeeping works without bridge credentials and never starts work", async () => {
    const f = fixture(false); f.bridge.failure = new BridgeError("credentials");
    try {
      const created = await f.create();
      expect(created.current!.status).toBe("active");
      expect(f.host.promptAttempts).toBe(0);
      expect(f.host.notices).toHaveLength(0);
      const result = await f.runtime.call("get", sessionID, {}, agentSource);
      expect(result.ok).toBe(true);
      expect(PublicResultSchema.safeParse(result).success).toBe(true);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    } finally { await f.runtime.dispose(); }
  });

  test("public schemas reject trusted fields and session IDs on native tools", () => {
    const target = { goalId: "goal_a", expectedRevision: 1 };
    const validInputs = {
      get: {}, history: {}, create: input, revise: { ...target, reason: "Clarify scope" },
      plan: { ...target, steps: [], reason: "Initial plan" },
      evidence: { ...target, criterionId: "accept", evidence: { summary: "Observed real check" } },
      checkpoint: { ...target, summary: "Current progress" }, complete: { ...target, summary: "Verified all work" },
      block: { ...target, blocker: "Account unavailable" }, pause: target, cancel: target, resume: target,
    };
    for (const [name, schema] of Object.entries(ToolSchemas)) {
      const valid = validInputs[name as keyof typeof validInputs];
      expect(schema.safeParse(valid).success).toBe(true);
      for (const field of ["actor", "trustedRecovery", "tokens", "executionAllowed", "sessionID", "owner", "explicitStop", "commandStart"]) {
        expect(schema.safeParse({ ...valid, [field]: true }).success).toBe(false);
      }
    }
    expect(ToolSchemas.resume.safeParse({ goalId: "goal_a", expectedRevision: 1, recover: true }).success).toBe(true);
    expect(RPCSchemas.get.safeParse({ sessionID, trustedRecovery: true }).success).toBe(false);
    expect(RPCSchemas.get.parse({ sessionID })).toEqual({ sessionID });
  });

  test("plan append through the public call returns a compact summary with the new revision", async () => {
    const f = fixture(false);
    try {
      const ids = { goalId: "goal_a", expectedRevision: 1 };
      expect(ToolSchemas.plan.safeParse({ ...ids, steps: [], reason: "Initial plan" }).success).toBe(true);
      expect(ToolSchemas.plan.parse({ ...ids, steps: [], reason: "Initial plan" }).mode).toBe("replace");
      expect(ToolSchemas.plan.safeParse({ ...ids, steps: [], reason: "Append", mode: "append" }).success).toBe(true);
      expect(ToolSchemas.plan.safeParse({ ...ids, steps: [], reason: "Bad", mode: "merge" }).success).toBe(false);

      const created = await f.create();
      const seeded = (await f.runtime.manage("plan", sessionID, {
        ...target(created), steps: [{ id: "a", description: "First step", status: "pending" }], reason: "Initial plan",
      }, agentSource))!;
      const result = await f.runtime.call("plan", sessionID, {
        ...target(seeded), steps: [{ id: "b", description: "Second step", status: "pending" }], reason: "Append one", mode: "append",
      }, agentSource);
      expect(result.ok).toBe(true);
      expect(PublicResultSchema.safeParse(result).success).toBe(true);
      if (!result.ok || !result.current) throw new Error("Test requires a successful plan result");
      expect(result.current).toMatchObject({ view: "summary", revision: seeded.current!.revision + 1, requiredStepsRemaining: 2, inspect: "tools.goals.get" });
      expect(result.current).not.toHaveProperty("plan");
      const full = (await f.runtime.manage("get", sessionID, {}, agentSource))!;
      expect(full.current!.plan.map(s => s.id)).toEqual(["a", "b"]);
      expect(full.current!.revision).toBe(seeded.current!.revision + 1);
    } finally { await f.runtime.dispose(); }
  });

  test("location mismatch and lost owner fail before goal mutations", async () => {
    const f = fixture();
    try {
      f.host.session.location = { directory: "/different/location" };
      expect(await f.runtime.call("create", sessionID, input, agentSource)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.store.values.size).toBe(0);
      expect(await f.runtime.context(sessionID, "build")).toBe("");
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_unrelated_user" });
      expect(f.store.values.size).toBe(0);
      f.host.session.location = f.host.location; f.owner.held = false;
      expect((await f.runtime.call("create", sessionID, input, agentSource)).ok).toBe(false);
      expect(f.store.values.size).toBe(0);
    } finally { f.owner.held = true; await f.runtime.dispose(); }
  });

  test("restricted agents, children and broad effective denies cannot execute", () => {
    const session: NativeSession = { id: sessionID, location: { directory: "/p" }, tokens, permissions: [] };
    expect(executionPolicy(session, { id: "build", mode: "primary", permissions: [] }, ["build"])).toBe(true);
    expect(executionPolicy(session, { id: "custom", mode: "primary", permissions: [] }, ["build"])).toBe(false);
    expect(executionPolicy(session, { id: "plan", mode: "primary", permissions: [] }, ["plan"])).toBe(false);
    expect(executionPolicy({ ...session, parentID: "ses_parent" }, { id: "build", mode: "primary", permissions: [] }, ["build"])).toBe(false);
    expect(executionPolicy({ ...session, permissions: [{ action: "edit", resource: "*", effect: "deny" }] }, { id: "build", mode: "primary", permissions: [] }, ["build"])).toBe(false);
    expect(executionPolicy(session, { id: "build", mode: "primary", permissions: [{ action: "shell", resource: "**", effect: "deny" }] }, ["build"])).toBe(false);
  });

  test("native Code Mode tools use context session/agent and captured executors return disposed result after disposal", async () => {
    const f = fixture(); const tools: { name: string; input?: unknown; output?: unknown; options?: Record<string, unknown>; execute: (input: unknown, context: unknown) => Promise<unknown> }[] = [];
    const ctx = { tool: { transform: async (callback: (editor: unknown) => void) => callback({ namespace() {}, add(tool: (typeof tools)[number]) { tools.push(tool); } }) } } as unknown as Plugin.Context;
    await registerTools(ctx, f.runtime);
    const expected = Object.keys(ToolSchemas).sort();
    expect(tools.map(t => t.name).sort()).toEqual(expected);
    expect(tools).toHaveLength(12);
    expect(new Set(tools.map(t => t.name)).size).toBe(12);
    expect(tools.every(t => t.options?.namespace === "goals" && t.options.codemode === true && !("permission" in t.options))).toBe(true);
    for (const tool of tools) {
      expect(tool.input).toBe(ToolSchemas[tool.name as keyof typeof ToolSchemas]);
      expect(tool.output).toBe(PublicResultSchema);
    }
    const seen: { operation: string; sessionID: string; source: { kind: string; agent?: unknown; signal?: unknown } }[] = [];
    const originalCall = f.runtime.call.bind(f.runtime);
    f.runtime.call = (async (operation: Parameters<typeof originalCall>[0], sessionIDArg: string, inputArg: unknown, source?: Parameters<typeof originalCall>[3]) => {
      seen.push({ operation, sessionID: sessionIDArg, source: { kind: source?.kind ?? "agent", agent: source?.agent, signal: source?.signal } });
      return originalCall(operation, sessionIDArg, inputArg, source);
    }) as typeof originalCall;
    const create = tools.find(t => t.name === "create")!;
    const get = tools.find(t => t.name === "get")!;
    const context = { sessionID, agent: "build", signal: new AbortController().signal };
    const created = await create.execute(input, context) as { output: { ok: boolean; current?: { view: string; revision: number; id: string } }; content: string };
    expect(created.output).toMatchObject({ ok: true, current: { view: "summary", revision: 1 } });
    expect(PublicResultSchema.safeParse(created.output).success).toBe(true);
    expect(JSON.parse(created.content)).toEqual(created.output);
    const createdId = created.output.current!.id;
    const stored = await f.get();
    expect(stored.current).toMatchObject({ id: createdId, revision: 1, status: "active" });
    const got = await get.execute({}, context) as { output: { ok: boolean; current?: { view: string; id: string; revision: number } }; content: string };
    expect(got.output).toMatchObject({ ok: true, current: { view: "full", id: createdId, revision: 1 } });
    expect(PublicResultSchema.safeParse(got.output).success).toBe(true);
    expect(JSON.parse(got.content)).toEqual(got.output);
    expect(f.host.promptAttempts).toBe(0);
    expect(f.host.notices).toHaveLength(0);
    expect(seen[0]).toMatchObject({ operation: "create", sessionID });
    expect(seen[0].source).toMatchObject({ kind: "agent", agent: "build" });
    expect(seen[0].source.signal).toBe(context.signal);
    expect(seen[1]).toMatchObject({ operation: "get", sessionID });
    expect(seen[1].source.signal).toBe(context.signal);
    const sizeBeforeEvil = f.store.values.size;
    const evil = await create.execute({ ...input, sessionID: "ses_evil", actor: { kind: "agent" } }, context) as { output: { ok: boolean; error?: { code: string } } };
    expect(evil.output).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(f.store.values.size).toBe(sizeBeforeEvil);
    expect((await f.get()).current).toMatchObject({ id: createdId, revision: 1 });
    const aborted = new AbortController(); aborted.abort();
    const abortedResult = await get.execute({}, { sessionID, agent: "build", signal: aborted.signal }) as { output: { ok: boolean } };
    expect(abortedResult.output).toMatchObject({ ok: false });
    expect((await f.get()).current).toMatchObject({ id: createdId, revision: 1 });
    await f.runtime.dispose();
    const writesBeforeDispose = f.store.values.size;
    const afterDispose = await create.execute(input, context) as { output: { ok: boolean; error?: { code: string } }; content: string };
    expect(afterDispose.output).toMatchObject({ ok: false, error: { code: "disposed" } });
    expect(PublicResultSchema.safeParse(afterDispose.output).success).toBe(true);
    expect(JSON.parse(afterDispose.content)).toEqual(afterDispose.output);
    expect(f.store.values.size).toBe(writesBeforeDispose);
    expect(f.owner.released).toBe(true);
  });

  test("pinned native Promise DTOs unwrap agent.data, validate permission identity and preserve admission flags", async () => {
    const admissions: Record<string, unknown>[] = [];
    const raw = {
      location: { directory: "/fixture/project" },
      session: {
        get: async () => ({ id: sessionID, location: { directory: "/fixture/project" }, tokens, permissions: [], time: { idle: 123 }, outcome: "succeeded" }),
        context: async () => [{ id: "msg_idle", type: "idle", time: { created: 123 }, outcome: "succeeded" }],
        prompt: async (data: Record<string, unknown>) => { admissions.push(data); return { id: data.id }; },
        synthetic: async (data: Record<string, unknown>) => { admissions.push(data); return { id: data.id }; },
      },
      agent: { get: async () => ({ location: { directory: "/fixture/project" }, data: { id: "build", mode: "primary", permissions: [] } }) },
      permission: { list: async () => [{ id: "per_pending", sessionID }] },
    };
    const host = nativeHost(raw as unknown as Plugin.Context);
    expect(await host.getAgent("build")).toEqual({ id: "build", mode: "primary", permissions: [] });
    expect((await host.getSession(sessionID)).idleTime).toBe(123);
    expect(await host.context(sessionID)).toMatchObject([{ id: "msg_idle", created: 123, outcome: "succeeded" }]);
    expect(await host.permissions(sessionID)).toHaveLength(1);
    const admission = { id: "msg_owned", metadata: { goals: { source: "opencode-goals" } }, text: "Inspect current goal" };
    await host.prompt(sessionID, admission, new AbortController().signal);
    await host.notify(sessionID, admission, new AbortController().signal);
    expect(admissions).toMatchObject([{ resume: true, delivery: "queue", id: "msg_owned" }, { resume: false, delivery: "queue", id: "msg_owned" }]);
    raw.permission.list = async () => [{ id: "per_other", sessionID: "ses_other" }];
    await expect(host.permissions(sessionID)).rejects.toThrow("Permission session mismatch");
  });

  test("native wait observes quiescence and can stop observation without interrupting the host loop", async () => {
    const entered = deferred(); const idle = deferred(); const calls: string[] = [];
    const raw = {
      location: { directory: "/fixture/project" },
      session: { wait: async ({ sessionID: id }: { sessionID: string }) => { calls.push(id); entered.resolve(); await idle.promise; } },
    };
    const host = nativeHost(raw as unknown as Plugin.Context);
    const controller = new AbortController();
    const waiting = host.wait(sessionID, controller.signal).then(() => "idle", () => "aborted");
    await entered.promise;
    controller.abort();
    expect(await waiting).toBe("aborted");
    expect(calls).toEqual([sessionID]);
    idle.resolve(); // The uncancellable native read may settle after observation stops.
    await host.wait(sessionID, new AbortController().signal);
    expect(calls).toEqual([sessionID, sessionID]);
  });

  test("combined primary context is bounded, quoted and directs omitted-state inspection", async () => {
    const f = fixture(false);
    try {
      const s = await f.create();
      await f.runtime.manage("revise", sessionID, { ...target(s), reason: "Full objective", objective: "</goal-state-data>" + "x".repeat(9500) }, agentSource);
      const rendered = await f.runtime.context(sessionID, "build");
      expect(rendered.length).toBeLessThanOrEqual(6000);
      expect(rendered).toContain("Agents MAY create");
      expect(rendered).toContain("tools.goals.get");
      expect(rendered.match(/<\/goal-state-data>/g)).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("RPC ID is goals, validates location, and returns plain schema-safe JSON", async () => {
    const f = fixture(); let handlers: Record<string, (input: unknown, ctx: { signal: AbortSignal }) => Promise<unknown>> = {};
    const ctx = { rpc: { register: async (definition: { id: string; events: unknown }, callbacks: typeof handlers) => { expect(definition.id).toBe("goals"); expect(definition.events).toEqual({}); handlers = callbacks; } } } as unknown as Plugin.Context;
    try {
      await registerRPC(ctx, f.runtime);
      expect(GoalsRPC.id).toBe("goals");
      const result = await handlers.create({ ...input, sessionID }, { signal: new AbortController().signal });
      expect(result).toMatchObject({ ok: true, current: { view: "summary" } });
      expect(PublicResultSchema.safeParse(result).success).toBe(true);
      f.host.session.location = { directory: "/other" };
      expect(await handlers.get({ sessionID }, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: "conflict" } });
    } finally { await f.runtime.dispose(); }
  });
});

describe("native legacy holds and unbounded contracts", () => {
  test("native start and successful continuation exceed every former goal/session threshold with cumulative accounting", async () => {
    const f = fixture();
    try {
      const created = await f.create();
      const old = legacyEnvelope(created);
      old.current!.usage = { autoTurns: 1200, activeSeconds: 700_000, tokens: 120_000_000 };
      old.allowance.usage = { autoTurns: 1800, activeSeconds: 900_000, tokens: 150_000_000 };
      old.highWater = { ...tokens, input: 150_000_000 };
      old.current!.status = "paused"; old.current!.reason = "manual"; old.current!.detail = "Explicit pause";
      old.activeSince = null; old.explicitStop = true;
      f.store.values.set([...f.store.values.keys()][0]!, old);
      f.host.session.tokens.input = 150_000_000;
      let state = await f.get();
      state = (await f.runtime.manage("resume", sessionID, target(state), agentSource))!;
      const started = await f.runtime.start(sessionID);
      expect(started.kind).toBe("admitted");
      const oldID = started.admissionId;
      f.bridge.state.inbox = []; f.host.messages.push({ id: oldID, type: "user", created: 10_000 });
      await f.begin(); f.host.session.tokens.reasoning = 7;
      await f.idle();
      state = await f.get();
      expect(f.host.admitted).toHaveLength(2);
      expect(f.host.admitted[1]!.id).not.toBe(oldID);
      expect(state.current).toMatchObject({ status: "active", reason: null, limits: null,
        usage: { autoTurns: 1202, tokens: 120_000_007 } });
      expect(state.current!.usage.activeSeconds).toBeGreaterThan(700_000);
      expect(state.allowance.usage).toMatchObject({ autoTurns: 1802, tokens: 150_000_007 });
      expect(state.allowance.usage.activeSeconds).toBeGreaterThan(900_000);
      expect(state.highWater).toEqual({ ...tokens, input: 150_000_000, reasoning: 7 });
      expect(f.runtime.publicSnapshot("get", state)).toMatchObject({ ok: true, current: { limits: null }, allowance: { limits: null }, diagnostics: { usageAccountingOnly: true } });
      expect(state.schemaVersion).toBe(2);
    } finally { await f.runtime.dispose(); }
  });

  test("budget hold survives completed event failure and restart until explicit guarded resume", async () => {
    const store = new Store(); const first = fixture(true, store);
    try {
      const held = await legacyBudgetHold(first);
      expect(held.current).toMatchObject({ status: "paused", reason: "budget", usage: { tokens: 10 } });
      first.host.streamFailure.resolve();
      await (first.runtime as unknown as { stream: Promise<void> }).stream;
      // Wait for the real stream consumer, not for a particular replacement reason.
      await first.runtime.dispose();
      expect(first.runtime.diagnostics().events).toBe("failed");
      expect(first.host.promptAttempts).toBe(0);
    } finally { await first.runtime.dispose(); }
    const second = fixture(true, store); second.host.session.tokens.input = 10;
    try {
      await second.get(); await second.runtime.drain();
      let held = (await second.runtime.manage("history", sessionID, {}, agentSource))!;
      expect(held.current!.status).toBe("paused");
      expect(held.current!.usage).toMatchObject({ autoTurns: 0, tokens: 10 });
      expect(second.host.promptAttempts).toBe(0);
      expect(await second.runtime.call("resume", sessionID, target(held), agentSource))
        .toMatchObject({ ok: false, error: { code: "recovery_required" } });
      held = (await second.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource))!;
      expect(held.current!.status).toBe("active");
      const started = await second.runtime.start(sessionID);
      expect(started.kind).toBe("admitted");
      expect(second.host.admitted).toHaveLength(1);
      expect(started.state.allowance.usage).toMatchObject({ autoTurns: 1, tokens: 10 });
    } finally { await second.runtime.dispose(); }
  });

  test("ordinary event failure still automatically recovers after a healthy restart", async () => {
    const store = new Store(); const first = fixture(true, store);
    try {
      await first.create();
      const paused = deferred();
      store.onWrite = value => { if ((value as SessionEnvelope).history.at(-1)?.action === "safety_pause") paused.resolve(); };
      first.host.streamFailure.resolve(); await paused.promise;
      await first.runtime.dispose();
      expect(first.runtime.diagnostics().events).toBe("failed");
    } finally { await first.runtime.dispose(); }
    const second = fixture(true, store);
    try {
      await second.get(); await second.runtime.drain();
      const recovered = (await second.runtime.manage("history", sessionID, {}, agentSource))!;
      expect(recovered.current!.status).toBe("active");
      expect(recovered.allowance.usage.autoTurns).toBe(1);
      expect(second.host.admitted).toHaveLength(1);
    } finally { await second.runtime.dispose(); }
  });

  test("legacy grants with a cleared F1 marker do not turn an unrelated internal failure into an explicit stop", async () => {
    const f = fixture();
    try {
      const old = legacyEnvelope(await f.create(), true);
      old.current!.status = "paused"; old.current!.reason = "runtime_failure"; old.current!.detail = "Unrelated internal failure after explicit recovery";
      old.activeSince = null; old.safetyPause = { reason: "runtime_failure", detail: "Unrelated internal failure" };
      f.store.values.set([...f.store.values.keys()][0]!, { ...old, budgetResumeRequired: false });
      await f.get(); await f.runtime.drain();
      const state = (await f.runtime.manage("history", sessionID, {}, agentSource))!;
      expect(state.current!.status).toBe("active"); expect(state.explicitStop).toBe(false);
      expect(state.allowance.usage.autoTurns).toBe(1); expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("registered Code Mode and typed RPC expose exactly twelve lifecycle operations and reject obsolete setters", async () => {
    const f = fixture(false);
    const expected = ["get", "create", "revise", "plan", "evidence", "checkpoint", "complete", "block", "pause", "cancel", "resume", "history"].sort();
    type Tool = { name: string; execute: (input: unknown, context: unknown) => Promise<{ output: unknown; content: string }> };
    const tools: Tool[] = [];
    let handlers: Record<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>> = {};
    const ctx = {
      tool: { transform: async (edit: (editor: unknown) => void) => edit({ namespace() {}, add(tool: Tool) { tools.push(tool); } }) },
      rpc: { register: async (_definition: unknown, registered: typeof handlers) => { handlers = registered; } },
    } as unknown as Plugin.Context;
    try {
      await registerTools(ctx, f.runtime); await registerRPC(ctx, f.runtime);
      // Both the advertised contract and the actually registered callable
      // handlers are exactly the twelve lifecycle operations: no board-only
      // snapshot on either surface.
      expect(Object.keys(GoalsRPC.methods).sort()).toEqual(expected);
      expect("snapshot" in GoalsRPC.methods).toBe(false);
      expect(tools.map(tool => tool.name).sort()).toEqual(expected);
      expect(Object.keys(handlers).sort()).toEqual(expected);
      expect("snapshot" in handlers).toBe(false);
      expect(GoalsRPC.methods).not.toHaveProperty("increase_limits");
      expect(handlers).not.toHaveProperty("increase_limits");
      const create = tools.find(tool => tool.name === "create")!;
      expect(await create.execute(input, { sessionID, agent: "build" })).toMatchObject({ output: { ok: true, current: { limits: null }, allowance: { limits: null } } });
      const s = await f.get();
      // Allowed lifecycle behavior through the real registered RPC handlers:
      // revision fencing and content revisions advance, so a no-op handler
      // returning canned success could never satisfy these outcomes.
      const signal = new AbortController().signal;
      const planned = await handlers.plan({
        ...target(s), sessionID,
        steps: [{ id: "rpc_step", description: "Registered handler step", status: "pending" }], reason: "Handler plan",
      }, { signal }) as { ok: boolean; current?: { revision: number } };
      expect(planned).toMatchObject({ ok: true, current: { revision: s.current!.revision + 1 } });
      expect(await handlers.revise({ ...target(s), sessionID, reason: "Stale handler rewrite" }, { signal }))
        .toMatchObject({ ok: false });
      expect(await f.runtime.call("snapshot" as never, sessionID, { sessionID }, agentSource))
        .toMatchObject({ ok: false, error: { code: "validation" } });
      const request = { ...target(await f.get()), limits: { tokenBudget: 3 }, reason: "Obsolete setter" };
      expect(await f.runtime.call("increase_limits" as never, sessionID, request, agentSource)).toMatchObject({ ok: false, error: { code: "validation" } });
      for (const limits of [null, {}, { tokenBudget: 3 }]) {
        expect(await create.execute({ ...input, limits }, { sessionID, agent: "build" })).toMatchObject({ output: { ok: false, error: { code: "validation" } } });
        expect(await handlers.revise({ ...target(s), sessionID, limits, reason: "Obsolete setter" }, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: "validation" } });
        expect(RPCSchemas.create.safeParse({ ...input, sessionID, limits }).success).toBe(false);
        expect(RPCSchemas.revise.safeParse({ ...target(s), sessionID, limits, reason: "Obsolete setter" }).success).toBe(false);
      }
      expect((await f.get()).current!.revision).toBe(s.current!.revision + 1);
      expect(f.host.promptAttempts).toBe(0);
      expect(f.host.notices).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  test("legacy hold never resumes on reads/events; explicit recovery still checks policy and native holds", async () => {
    const f = fixture();
    try {
      let held = await legacyBudgetHold(f);
      expect(held.current).toMatchObject({ status: "paused", reason: "budget", usage: { tokens: 10 } });
      const generation = held.current!.generation;
      await f.runtime.context(sessionID, "build"); f.emit("session.usage.updated"); await f.runtime.drain();
      held = await f.get(); await f.runtime.drain();
      expect(held.current).toMatchObject({ status: "paused", reason: "budget", generation, usage: { tokens: 10 } });
      expect(f.host.promptAttempts).toBe(0);
      expect(f.runtime.diagnostics(sessionID).recovery).toBeUndefined();
      expect(await f.runtime.call("resume", sessionID, target(held), agentSource)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      expect(await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, { kind: "agent", agent: "plan" }))
        .toMatchObject({ ok: false, error: { code: "execution_restricted" } });
      f.host.pendingPermissions = [{ id: "per_pending" }];
      const scheduled = await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource);
      expect(scheduled).toMatchObject({ ok: true, current: { status: "paused", reason: "budget" }, diagnostics: { recovery: "scheduled" } });
      await f.runtime.drain();
      expect(f.runtime.diagnostics(sessionID).recovery).toBe("waiting");
      expect(f.host.promptAttempts).toBe(0);
      f.host.pendingPermissions = []; await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(1);
      const resumed = await f.get();
      expect(resumed.current!.status).toBe("active");
      expect(resumed.current!.usage.tokens).toBe(10);
      expect(resumed.allowance.usage.autoTurns).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  for (const stop of ["pause", "cancel"] as const) {
    test(`${stop} after a legacy recovery request fences it despite subsequent bookkeeping`, async () => {
      const f = fixture();
      try {
        let held = await legacyBudgetHold(f);
        f.bridge.state.active = true;
        await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
        held = (await f.runtime.manage(stop, sessionID, target(held), agentSource))!;
        if (stop === "pause") {
          held = (await f.runtime.manage("checkpoint", sessionID, { ...target(held), summary: "Still held" }, agentSource))!;
          expect(held.explicitStop).toBe(true);
        } else {
          expect(await f.runtime.call("checkpoint", sessionID, { ...target(held), summary: "Too late" }, agentSource)).toMatchObject({ ok: false, error: { code: "closed_goal" } });
        }
        f.bridge.state.active = false; await f.begin(); await f.idle(); await f.get(); await f.runtime.drain();
        expect((await f.get()).current!.status).toBe(stop === "pause" ? "paused" : "cancelled");
        expect(f.host.promptAttempts).toBe(0);
        expect(f.runtime.diagnostics(sessionID).recovery).toBeUndefined();
      } finally { await f.runtime.dispose(); }
    });
  }

  test("legacy hold migration cannot retire unknown delivery; exact proof permits a fresh charged recovery", async () => {
    const f = fixture();
    try {
      await f.create();
      f.bridge.beforeCancel = async () => { f.bridge.state.inbox = []; };
      await f.runtime.start(sessionID);
      let held = await legacyBudgetHold(f, await f.get());
      const oldID = held.dispatch!.id;
      expect(held.current!.reason).toBe("budget");
      expect(held.dispatch).toMatchObject({ id: oldID, phase: "invalidated" });
      const waiting = await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource);
      expect(waiting).toMatchObject({ ok: true, current: { status: "paused", reason: "budget" }, diagnostics: { recovery: "waiting" } });
      await f.runtime.drain();
      expect((await f.get()).dispatch!.id).toBe(oldID);
      expect(f.host.admitted).toHaveLength(1);
      f.host.messages.push({ id: oldID, type: "user", created: 10_010 });
      f.runtime.acceptEvent({ type: "session.inbox.delivered", created: 10_010, location: f.host.location, data: { sessionID, inboxID: oldID } });
      await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(2);
      expect(f.host.admitted[1]!.id).not.toBe(oldID);
      expect((await f.get()).allowance.usage.autoTurns).toBe(2);
    } finally { await f.runtime.dispose(); }
  });
});

describe("guarded scheduling", () => {
  for (const kind of ["shell", "child"] as const) {
    test(`background ${kind} defers without charging and real completion permits exactly one continuation`, async () => {
      const f = fixture();
      const complete = (id: string) => f.runtime.acceptEvent(kind === "shell"
        ? { type: "shell.exited", created: 10_100, location: f.host.location, data: { id, status: "exited" } }
        : { type: "session.execution.succeeded", created: 10_100, data: { sessionID: id } });
      try {
        await f.create(); await f.begin();
        if (kind === "shell") f.bridge.jobs.shells = ["sh_owned"];
        else f.bridge.jobs.children = ["ses_child"];
        await f.idle();
        expect(f.host.promptAttempts).toBe(0);
        expect((await f.get()).allowance.usage.autoTurns).toBe(0);
        expect((await f.get()).dispatch).toBeNull();
        complete(kind === "shell" ? "sh_unrelated" : "ses_unrelated");
        await f.runtime.drain();
        expect(f.host.waitCalls).toBe(1); // Unrelated jobs cannot wake the parent.
        f.bridge.jobs = { shells: [], children: [] };
        complete(kind === "shell" ? "sh_owned" : "ses_child");
        complete(kind === "shell" ? "sh_owned" : "ses_child");
        await f.runtime.drain();
        expect(f.host.admitted).toHaveLength(1);
        expect((await f.get()).allowance.usage.autoTurns).toBe(1);
        complete(kind === "shell" ? "sh_owned" : "ses_child");
        await f.runtime.drain();
        expect(f.host.admitted).toHaveLength(1);
      } finally { await f.runtime.dispose(); }
    });
  }

  test("completion racing the background snapshot is not lost; other busy work still blocks", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin();
      f.bridge.jobs = { shells: ["sh_owned"], children: ["ses_child"] };
      f.bridge.beforeBackground = async () => {
        f.bridge.beforeBackground = undefined;
        f.bridge.jobs.shells = [];
        f.runtime.acceptEvent({ type: "shell.exited", created: 10_100, data: { id: "sh_owned", status: "exited" } });
      };
      await f.idle();
      expect(f.host.waitCalls).toBe(2);
      expect(f.host.admitted).toHaveLength(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      f.bridge.jobs.children = [];
      f.runtime.acceptEvent({ type: "session.execution.succeeded", created: 10_110, data: { sessionID: "ses_child" } });
      await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  for (const stop of ["pause", "block", "cancel", "user", "dispose"] as const) {
    test(`${stop} invalidates deferred background completion without a reservation`, async () => {
      const f = fixture();
      try {
        const state = await f.create(); await f.begin();
        f.bridge.jobs.shells = ["sh_owned"]; await f.idle();
        expect(f.host.promptAttempts).toBe(0);
        if (stop === "user") await f.runtime.guardPrompt({ sessionID, messageID: "msg_real_user" });
        else if (stop === "dispose") await f.runtime.dispose();
        else await f.runtime.manage(stop, sessionID, { ...target(state), ...(stop === "block" ? { blocker: "Dependency unavailable" } : {}) }, agentSource);
        f.bridge.jobs.shells = [];
        f.runtime.acceptEvent({ type: "shell.exited", created: 10_100, data: { id: "sh_owned", status: "exited" } });
        await f.runtime.drain();
        expect(f.host.admitted).toHaveLength(0);
        if (stop !== "dispose") expect((await f.get()).allowance.usage.autoTurns).toBe(0);
        else expect(([...f.store.values.values()][0] as unknown as SessionEnvelope).allowance.usage.autoTurns).toBe(0);
      } finally { await f.runtime.dispose(); }
    });
  }

  test("unavailable background safety state pauses before any admission or charge", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin();
      f.bridge.beforeBackground = async () => { throw new BridgeError("shape"); };
      await f.idle();
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      expect((await f.get()).current).toMatchObject({ status: "paused", reason: "runtime_failure" });
    } finally { await f.runtime.dispose(); }
  });

  test("a new parent execution supersedes a deferred boundary and needs its own terminal success", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin();
      f.bridge.jobs.children = ["ses_child"]; await f.idle();
      await f.begin();
      f.bridge.jobs.children = [];
      f.runtime.acceptEvent({ type: "session.execution.succeeded", created: 10_100, data: { sessionID: "ses_child" } });
      await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      await f.idle();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  test("a superseding execution failure during reservation persistence makes ZERO native prompt calls and keeps the charge", async () => {
    const f = fixture(); const reserving = deferred(); const release = deferred();
    try {
      await f.create(); await f.begin();
      let held = false;
      f.store.beforeWrite = async state => {
        if (!held && state.dispatch?.phase === "reserved") { held = true; reserving.resolve(); await release.promise; }
      };
      f.succeed(); await reserving.promise;
      f.advance(); f.emit("session.execution.started"); f.emit("session.execution.failed");
      release.resolve(); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      expect(f.host.admitted).toHaveLength(0);
      const state = await f.get();
      expect(state.allowance.usage.autoTurns).toBe(1);
      expect(state.current!.status).toBe("paused");
      expect(state.dispatch).toBeNull(); // Known never submitted; no active reserved-intent stall.
      expect(f.bridge.cancelled).toEqual([]);
      const resumed = await f.runtime.manage("resume", sessionID, { ...target(state), recover: true }, agentSource);
      expect(resumed!.current!.status).toBe("active");
      expect(resumed!.allowance.usage.autoTurns).toBe(1);
      expect(f.host.promptAttempts).toBe(0); // Reconciliation is neither replay nor refund.
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  for (const kind of ["shell", "child"] as const) {
    test(`owned ${kind} starting during reservation suppresses submission once, retaining only the existing charge`, async () => {
      const f = fixture(); const reserving = deferred(); const release = deferred();
      try {
        await f.create(); await f.begin();
        let reservedWrites = 0;
        f.store.beforeWrite = async state => {
          if (state.dispatch?.phase === "reserved") {
            reservedWrites++;
            reserving.resolve(); await release.promise;
          }
        };
        f.succeed(); await reserving.promise;
        // The initial authoritative inventory was empty. Work begins only once
        // reserveDispatch has reached its durable-write boundary.
        if (kind === "shell") f.bridge.jobs.shells = ["sh_late"];
        else f.bridge.jobs.children = ["ses_late"];
        release.resolve(); await f.runtime.drain();
        expect(f.host.promptAttempts).toBe(0);
        const stopped = await f.get();
        expect(stopped.current).toMatchObject({ status: "paused", reason: "ambiguous" });
        expect(stopped.dispatch).toBeNull(); // Proven never submitted; exact intent safely retired.
        expect(stopped.allowance.usage.autoTurns).toBe(1);
        expect(stopped.current!.usage.autoTurns).toBe(1);
        expect(f.host.admitted).toHaveLength(0);
        expect(f.host.notices).toHaveLength(0);

        const completion = () => f.runtime.acceptEvent(kind === "shell"
          ? { type: "shell.exited", created: 10_100, data: { id: "sh_late", status: "exited" } }
          : { type: "session.execution.succeeded", created: 10_100, data: { sessionID: "ses_late" } });
        completion(); f.emit("session.execution.succeeded"); completion();
        await f.runtime.drain();
        f.bridge.jobs = { shells: [], children: [] };
        completion(); completion(); await f.runtime.drain();
        expect(reservedWrites).toBe(1);
        expect(f.host.promptAttempts).toBe(0);
        expect((await f.get()).allowance.usage.autoTurns).toBe(1);
        expect((await f.get()).dispatch).toBeNull();

        const resumed = await f.runtime.manage("resume", sessionID, { ...target(await f.get()), recover: true }, agentSource);
        expect(resumed!.current!.status).toBe("active"); // No permanently stuck reserved intent.
        expect(resumed!.allowance.usage.autoTurns).toBe(1); // Reconciliation is not a refund or replay.
        expect(f.host.promptAttempts).toBe(0);
      } finally { release.resolve(); await f.runtime.dispose(); }
    });
  }

  test("in-flight background completion history fails closed at its bounded capacity", async () => {
    const f = fixture(); const inspecting = deferred(); const release = deferred();
    try {
      await f.create(); await f.begin();
      f.bridge.jobs.shells = ["sh_owned"];
      f.bridge.beforeBackground = async () => { inspecting.resolve(); await release.promise; };
      f.succeed(); await inspecting.promise;
      const complete = (index: number) => f.runtime.acceptEvent({
        type: "shell.exited", created: 10_100, data: { id: `sh_concurrent_${index}`, status: "exited" },
      });
      for (let index = 0; index < 128; index++) complete(index);
      expect(f.runtime.diagnostics().events).toBe("observing");
      complete(128);
      expect(f.runtime.diagnostics().events).toBe("failed");
      release.resolve(); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  for (const stage of ["eligibility", "native-policy", "native-inbox", "native-state"] as const) {
    test(`source execution fencing survives the late ${stage} await`, async () => {
      const f = fixture(); const entered = deferred(); const release = deferred();
      try {
        await f.create(); await f.begin();
        let reserved = false; let held = false; let nativeInspected = false;
        f.store.onWrite = value => { if ((value as SessionEnvelope).dispatch?.phase === "reserved") reserved = true; };
        const gate = async () => {
          if (held || !reserved || (stage !== "eligibility" && !f.host.promptAttempts)) return;
          held = true; entered.resolve(); await release.promise;
        };
        if (stage === "native-state") {
          f.bridge.beforeInspect = async () => { if (f.host.promptAttempts) nativeInspected = true; };
          f.store.beforeRead = async () => { if (nativeInspected) await gate(); };
        } else if (stage === "native-inbox") f.bridge.beforeInspect = gate;
        else f.host.beforeAgent = gate;
        f.succeed(); await entered.promise;
        f.advance(); f.emit("session.execution.started"); f.emit("session.execution.failed");
        release.resolve(); await f.runtime.drain();
        expect(f.host.promptAttempts, stage).toBe(stage === "eligibility" ? 0 : 1);
        expect(f.host.admitted, stage).toHaveLength(0);
        const state = await f.get();
        expect(state.current!.status, stage).toBe("paused");
        expect(state.allowance.usage.autoTurns, stage).toBe(1);
        // Once the native call was made, delivery remains ambiguous, not asserted absent.
        expect(state.dispatch === null, stage).toBe(stage === "eligibility");
      } finally { release.resolve(); await f.runtime.dispose(); }
    });
  }

  test("restriction stops withdraw ONLY the owned pending input immediately", async () => {
    for (const stop of ["restricted-context"] as const) {
      const f = fixture(false);
      try {
        await f.create();
        const started = await f.runtime.start(sessionID);
        for (const type of ["user", "move", "synthetic"] as const) f.bridge.state.inbox.push({
          id: `msg_foreign_${type}`, sessionID, type, payload: {}, delivery: "queue", time: { created: 10_000 },
        });
        if (stop === "restricted-context") await f.runtime.context(sessionID, "plan");
        // Assert before a get could perform another accounting/withdrawal observation.
        expect(f.bridge.cancelled, stop).toEqual([started.admissionId]);
        expect(f.bridge.state.inbox.map(i => i.id), stop).toEqual(["msg_foreign_user", "msg_foreign_move", "msg_foreign_synthetic"]);
        expect(f.host.promptAttempts, stop).toBe(1);
        const state = await f.get();
        expect(state.current, stop).toMatchObject({ status: "paused", reason: "restricted" });
        expect(state.dispatch?.phase, stop).toBe("invalidated");
        expect(state.allowance.usage.autoTurns, stop).toBe(1);
      } finally { await f.runtime.dispose(); }
    }
  });

  test("the execution started by a successfully admitted input does not invalidate its acknowledgment or following continuation", async () => {
    for (const initial of ["manual", "automatic"] as const) {
      const f = fixture();
      try {
        await f.create(); await f.begin();
        f.host.afterGuard = async () => { f.advance(); f.emit("session.execution.started"); };
        if (initial === "manual") await f.runtime.start(sessionID);
        else await f.idle();
        await f.runtime.drain();
        const admitted = f.host.admitted[0];
        expect(f.host.admitted, initial).toHaveLength(1);
        expect((await f.get()).dispatch, initial).toMatchObject({ id: admitted.id, phase: "admitted" });
        expect((await f.get()).current!.status, initial).toBe("active");
        f.host.afterGuard = undefined; f.bridge.state.inbox = [];
        f.host.messages.push({ id: admitted.id, type: "user", created: 10_030 });
        await f.idle();
        expect(f.host.admitted, initial).toHaveLength(2);
        expect((await f.get()).allowance.usage.autoTurns, initial).toBe(2);
      } finally { await f.runtime.dispose(); }
    }
  });

  test("locationless first execution continues once from terminal success, only after the native loop becomes idle", async () => {
    const f = fixture(); const waiting = deferred(); const release = deferred();
    try {
      // Started precedes the first tool/context call, so the session is not known yet.
      f.advance(); f.emit("session.execution.started");
      await f.runtime.context(sessionID, "build"); await f.create();
      f.bridge.state.active = true;
      f.host.beforeIdle = async () => { waiting.resolve(); await release.promise; f.bridge.state.active = false; };
      f.advance(); f.host.session.outcome = "succeeded"; f.host.session.idleTime = 10_020;
      f.host.messages.push({ id: "msg_actual_idle", type: "idle", created: 10_020, outcome: "succeeded" });
      f.advance(); f.emit("session.execution.succeeded");
      // Observe without hanging on the intentionally unresolved native wait.
      await Promise.race([waiting.promise, f.runtime.drain()]);
      expect(f.host.admitted).toHaveLength(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      release.resolve(); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.waitCalls).toBe(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
      f.emit("session.execution.succeeded"); f.emit("session.idle"); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.waitCalls).toBe(1);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("fresh success + actual idle boundary reserves once; duplicate idle cannot spin", async () => {
    const f = fixture();
    try {
      await f.create(); f.emit("session.idle"); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(0); // No startup replay or idle-alone inference.
      await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(1);
      f.emit("session.idle"); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
      expect(f.bridge.checks).toBeGreaterThanOrEqual(3);
    } finally { await f.runtime.dispose(); }
  });

  test("terminal success requires a fresh started execution and its matching successful idle message/session", async () => {
    for (const mismatch of ["no-start", "startup-replay", "no-message", "message-outcome", "session-outcome", "idle-time", "older-idle", "later-idle"] as const) {
      const f = fixture();
      try {
        await f.create();
        if (mismatch === "startup-replay") f.runtime.acceptEvent({ type: "session.execution.started", created: 9_999, data: { sessionID } });
        else if (mismatch !== "no-start") await f.begin();
        f.host.session.outcome = mismatch === "session-outcome" ? "interrupted" : "succeeded";
        f.host.session.idleTime = mismatch === "idle-time" ? 10_019 : 10_020;
        if (mismatch !== "no-message") f.host.messages.push({
          id: "msg_boundary", type: "idle", created: mismatch === "older-idle" ? 10_001 : mismatch === "later-idle" ? 10_031 : 10_020,
          outcome: mismatch === "message-outcome" ? "failed" : "succeeded",
        });
        // Make timestamp-mismatch cases consistent with the session projection,
        // so only the execution/idle pairing (not idleTime) rejects them.
        if (mismatch === "older-idle" || mismatch === "later-idle") f.host.session.idleTime = f.host.messages[0].created;
        f.advance(20); f.emit("session.execution.succeeded"); await f.runtime.drain();
        expect(f.host.admitted, mismatch).toHaveLength(0);
        expect((await f.get()).allowance.usage.autoTurns, mismatch).toBe(0);
      } finally { await f.runtime.dispose(); }
    }
  });

  test("provisional locationless events cannot operate on a session in another location", async () => {
    const f = fixture();
    try {
      f.host.session.location = { directory: "/foreign" };
      f.advance(); f.emit("session.execution.started"); await f.runtime.drain();
      f.succeed(); await f.runtime.drain();
      expect(f.host.waitCalls).toBe(0);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.store.values.size).toBe(0);
      f.host.session.location = f.host.location;
      await f.create(); await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("locationless native usage updates account all normalized categories without staling content revisions", async () => {
    const f = fixture();
    try {
      const created = await f.create();
      f.host.session.tokens = { input: 10, output: 7, reasoning: 13, cache: { read: 5, write: 3 } };
      f.emit("session.usage.updated"); await f.runtime.drain();
      const state = await f.get();
      expect(state.allowance.usage.tokens).toBe(38);
      expect(state.current!.revision).toBe(created.current!.revision);
      expect(f.host.admitted).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  test("pause or goal replacement while waiting invalidates the old successful terminal boundary", async () => {
    for (const operation of ["pause", "replacement"] as const) {
      const f = fixture(); const waiting = deferred(); const release = deferred();
      try {
        const a = await f.create(); await f.begin();
        f.host.beforeIdle = async () => { waiting.resolve(); await release.promise; };
        f.succeed(); await waiting.promise;
        await f.runtime.manage(operation === "pause" ? "pause" : "cancel", sessionID, target(a), agentSource);
        const current = operation === "replacement" ? (await f.create()).current! : (await f.get()).current!;
        // Cancellation of the observation does not require native execution to finish.
        await f.runtime.drain();
        release.resolve(); f.emit("session.execution.succeeded"); await f.runtime.drain();
        expect(f.host.admitted).toHaveLength(0);
        expect((await f.get()).current).toMatchObject({ id: current.id, status: operation === "pause" ? "paused" : "active" });
        expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      } finally { release.resolve(); await f.runtime.dispose(); }
    }
  });

  test("a newer execution supersedes a pending success wait and needs its own successful idle boundary", async () => {
    const f = fixture(); const waiting = deferred(); const release = deferred();
    try {
      await f.create(); await f.begin();
      f.host.beforeIdle = async () => { waiting.resolve(); await release.promise; };
      f.succeed(); await waiting.promise;
      f.advance(); f.emit("session.execution.started"); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(0);
      release.resolve(); f.host.beforeIdle = undefined;
      await f.idle();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("disposal fences a pending native idle wait and releases ownership without awaiting unrelated execution", async () => {
    const f = fixture(); const waiting = deferred(); const release = deferred();
    try {
      await f.create(); await f.begin();
      f.host.beforeIdle = async () => { waiting.resolve(); await release.promise; };
      f.succeed(); await waiting.promise;
      await f.runtime.dispose();
      expect(f.owner.released).toBe(true);
      release.resolve();
      expect(f.host.admitted).toHaveLength(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("a deliberately started native execution remains observable and may continue when automation is enabled", async () => {
    const f = fixture();
    try {
      await f.create(); const first = await f.runtime.start(sessionID);
      f.bridge.state.inbox = [];
      f.host.messages.push({ id: first.admissionId, type: "user", created: 10_000 });
      await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(2);
      expect(f.host.admitted.map(a => a.metadata.goals)).toMatchObject([{ kind: "start" }, { kind: "continue" }]);
      expect((await f.get()).allowance.usage.autoTurns).toBe(2);
    } finally { await f.runtime.dispose(); }
  });

  test("an actual last context agent supports an unset default; an unknown agent is never guessed as build", async () => {
    const f = fixture(); f.bridge.defaultName = undefined; f.host.session.agent = undefined;
    try {
      const unknown = await f.runtime.manage("create", sessionID, input);
      expect(unknown!.current).toMatchObject({ status: "paused", reason: "restricted" });
      await f.runtime.context(sessionID, "build");
      const current = await f.get();
      await f.runtime.manage("resume", sessionID, target(current), agentSource);
      await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("all foreign pending work, forms and permissions block admissions", async () => {
    for (const blocker of ["user", "move", "compaction", "synthetic", "form", "permission", "active"] as const) {
      const f = fixture();
      try {
        await f.create(); await f.begin();
        if (["user", "move", "compaction", "synthetic"].includes(blocker)) f.bridge.state.inbox.push({ id: "msg_foreign", sessionID, type: blocker as "user", payload: {}, delivery: "queue", time: { created: 10_000 } });
        if (blocker === "form") f.bridge.state.forms.push({ id: "frm_wait", sessionID });
        if (blocker === "permission") f.host.pendingPermissions.push({ id: "per_wait" });
        if (blocker === "active") f.bridge.state.active = true;
        await f.idle();
        expect(f.host.promptAttempts).toBe(0);
        expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      } finally { await f.runtime.dispose(); }
    }
  });

  test("bridge identity/read failure pauses and never falls back to unsafe native admission", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin(); f.bridge.failure = new BridgeError("identity"); await f.idle();
      expect(f.host.promptAttempts).toBe(0);
      const state = await f.get(); expect(state.current).toMatchObject({ status: "paused", reason: "runtime_failure" });
      expect(f.runtime.diagnostics()).toMatchObject({ bridge: "unavailable", reason: "identity" });
    } finally { await f.runtime.dispose(); }
  });

  test("failure and interruption pause their run without blind retry", async () => {
    for (const outcome of ["failed", "interrupted"]) {
      const f = fixture();
      try {
        await f.create(); await f.begin(); f.emit(`session.execution.${outcome}`); await f.runtime.drain();
        expect((await f.get()).current).toMatchObject({ status: "paused", reason: outcome });
        expect(f.host.admitted).toHaveLength(0);
      } finally { await f.runtime.dispose(); }
    }
  });

  test("an immediate failure before the first model call still targets the captured known goal", async () => {
    const f = fixture();
    try {
      await f.create(); f.advance();
      f.emit("session.execution.started"); f.emit("session.execution.failed");
      await f.runtime.drain();
      expect((await f.get()).current).toMatchObject({ status: "paused", reason: "failed" });
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("late failure from A cannot pause replacement B", async () => {
    const f = fixture();
    try {
      const a = await f.create(); await f.begin();
      await f.runtime.manage("cancel", sessionID, target(a), agentSource);
      const b = await f.runtime.manage("create", sessionID, { ...input, objective: "Replacement B" }, agentSource);
      f.emit("session.execution.failed"); await f.runtime.drain();
      expect((await f.get()).current).toMatchObject({ id: b!.current!.id, status: "active" });
    } finally { await f.runtime.dispose(); }
  });

  test("pause after native guard but before admission acknowledgment withdraws ONLY owned input", async () => {
    const f = fixture(false); const guarded = deferred(); const release = deferred();
    try {
      const created = await f.create();
      f.host.afterGuard = async () => { guarded.resolve(); await release.promise; };
      const starting = f.runtime.start(sessionID);
      await guarded.promise;
      await f.runtime.manage("pause", sessionID, target(created), agentSource);
      // Foreign work can arrive during the admission race; it must never be cancelled.
      f.bridge.state.inbox.push({ id: "msg_user_during_race", sessionID, type: "user", payload: {}, delivery: "queue", time: { created: 10_000 } });
      release.resolve();
      const result = await starting;
      expect(result.kind).toBe("withdrawal_requested");
      expect(f.bridge.cancelled).toEqual([result.admissionId]);
      expect(f.bridge.state.inbox.map(i => i.id)).toEqual(["msg_user_during_race"]);
      expect(result.state.current!.status).toBe("paused");
      expect(result.state.allowance.usage.autoTurns).toBe(1);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("pause before native hook rejects stale admission instead of rewriting prompt", async () => {
    const f = fixture(false); const entered = deferred(); const release = deferred();
    try {
      const created = await f.create();
      f.host.beforePrompt = async () => { entered.resolve(); await release.promise; };
      const starting = f.runtime.start(sessionID).then(() => ({ error: null }), error => ({ error }));
      await entered.promise;
      await f.runtime.manage("pause", sessionID, target(created), agentSource);
      release.resolve(); expect((await starting).error).toMatchObject({ code: "invalid_transition" });
      expect(f.host.admitted).toHaveLength(0);
      expect((await f.get()).current!.status).toBe("paused");
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("deliberate manual start is bounded with autoContinue off and creates no passive notice", async () => {
    const f = fixture(false);
    try {
      await f.create(); const result = await f.runtime.start(sessionID);
      expect(result.kind).toBe("admitted");
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.notices).toHaveLength(0);
      expect(result.state.allowance.usage.autoTurns).toBe(1);
      expect(f.host.admitted[0].metadata).toMatchObject({ goals: { kind: "start" } });
      await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("prior owned input must be observably delivered before another idle continuation", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin(); await f.idle();
      const owned = f.host.admitted[0];
      f.bridge.state.inbox = []; // Absence is deliberately NOT enough.
      await f.begin(); await f.idle(); expect(f.host.admitted).toHaveLength(1);
      f.host.messages.push({ id: owned.id, type: "user", created: 10_020, metadata: owned.metadata });
      await f.begin(); await f.idle(); expect(f.host.admitted).toHaveLength(2);
    } finally { await f.runtime.dispose(); }
  });

  test("restart pauses without replay and agent recover request performs actual reconciliation", async () => {
    const store = new Store(); const first = fixture(false, store);
    await first.create(); const started = await first.runtime.start(sessionID);
    await first.runtime.dispose();
    const second = fixture(false, store);
    second.bridge.state.inbox = structuredClone(first.bridge.state.inbox);
    try {
      let state = await second.get();
      expect(state.current).toMatchObject({ status: "paused", reason: "restart" });
      expect(second.host.promptAttempts).toBe(0);
      const denied = await second.runtime.call("resume", sessionID, { ...target(state), recover: false }, agentSource);
      expect(denied).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      state = (await second.runtime.manage("resume", sessionID, { ...target(state), recover: true }, agentSource))!;
      expect(state.current!.status).toBe("active");
      expect(state.dispatch).toBeNull();
      expect(state.allowance.usage.autoTurns).toBe(1);
      expect(second.bridge.cancelled).toEqual([started.admissionId]);
      expect(second.host.promptAttempts).toBe(0); // Recovery is not replay/start.
    } finally { await second.runtime.dispose(); }
  });

  test("unknown delivery with no pending item or context boundary cannot be asserted recovered", async () => {
    const store = new Store(); const first = fixture(false, store);
    await first.create(); await first.runtime.start(sessionID); await first.runtime.dispose();
    const second = fixture(false, store);
    try {
      const state = await second.get();
      expect(await second.runtime.call("resume", sessionID, { ...target(state), recover: true }, agentSource)).toMatchObject({ ok: true, current: { status: "paused", reason: "restart" }, diagnostics: { recovery: "waiting" } });
      await second.runtime.drain();
      expect((await second.get()).current!.status).toBe("paused");
      expect((await second.get()).allowance.usage.autoTurns).toBe(1);
      expect(second.host.promptAttempts).toBe(0);
    } finally { await second.runtime.dispose(); }
  });

  test("event-stream loss pauses active owned goals and disables unobserved automation", async () => {
    const f = fixture(); const persisted = deferred();
    try {
      await f.create();
      f.store.onWrite = value => { if ((value as SessionEnvelope).current?.reason === "runtime_failure") persisted.resolve(); };
      f.host.streamFailure.resolve(); await persisted.promise;
      expect((await f.get()).current).toMatchObject({ status: "paused", reason: "runtime_failure" });
      expect(f.runtime.diagnostics().events).toBe("failed");
      await expect(f.runtime.start(sessionID)).rejects.toMatchObject({ code: "recovery_required" });
      await f.begin(); await f.idle(); expect(f.host.admitted).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  test("passive notices are queued, never reported as delivered or used to wake the session", async () => {
    const f = fixture(false);
    try {
      await f.create(); await f.runtime.notify(sessionID, "Current goal is paused");
      expect(f.host.notices).toHaveLength(1);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.bridge.state.inbox[0]).toMatchObject({ type: "synthetic" });
      expect(f.host.messages).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });
});

describe("runtime-owned recovery", () => {
  async function failedGoal(f: ReturnType<typeof fixture>) {
    await f.create(); await f.begin(); f.emit("session.execution.failed"); await f.runtime.drain();
    return f.get();
  }
  async function noProgressGoal(f: ReturnType<typeof fixture>) {
    const created = await f.create();
    await f.runtime.manage("checkpoint", sessionID, { ...target(created), summary: "Initial verified milestone", evidence: "Initial focused test passed" }, agentSource);
    for (let turn = 0; turn < 3; turn++) {
      const old = f.host.admitted.at(-1);
      if (old) { f.bridge.state.inbox = []; f.host.messages.push({ id: old.id, type: "user", created: 10_000 }); }
      await f.begin(); await f.idle();
    }
    const held = await f.get();
    expect(held.current).toMatchObject({ status: "paused", reason: "no_progress", noProgress: 2 });
    expect(held.allowance.usage.autoTurns).toBe(2);
    return held;
  }

  test("summary-only bookkeeping neither counts as verification progress nor clears a no-progress recovery hold", async () => {
    const f = fixture();
    try {
      let held = await noProgressGoal(f);
      const before = structuredClone(held.current!);
      held = (await f.runtime.manage("checkpoint", sessionID, { ...target(held), summary: "More words are not evidence" }, agentSource))!;
      expect(held.current).toMatchObject({ status: "paused", reason: "no_progress", progress: before.progress, dispatchProgress: before.dispatchProgress, noProgress: 2, generation: before.generation });
      expect(await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(2);
      expect((await f.get()).allowance.usage.autoTurns).toBe(2);
    } finally { await f.runtime.dispose(); }
  });

  test("active caller returns a schema-safe scheduled result without waiting or reserving; idle admits a fresh ID once", async () => {
    const f = fixture();
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      const waitCalls = f.host.waitCalls;
      const result = await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource);
      expect(result).toMatchObject({ ok: true, current: { status: "paused", reason: "failed" }, diagnostics: { recovery: "scheduled" } });
      expect(PublicResultSchema.safeParse(result).success).toBe(true);
      await f.runtime.drain();
      expect(f.host.waitCalls).toBe(waitCalls);
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      f.bridge.state.active = false; await f.idle();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).current!.status).toBe("active");
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
      f.emit("session.execution.succeeded"); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("recovery defers across successful idle while a correlated background shell remains; completion admits once", async () => {
    const f = fixture();
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource);
      await f.runtime.drain(); f.bridge.state.active = false; f.bridge.jobs.shells = ["sh_recovery"];
      await f.idle();
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
      f.bridge.jobs.shells = [];
      const completion = { type: "shell.exited", created: 10_200, data: { id: "sh_recovery", status: "exited" } };
      f.runtime.acceptEvent(completion); f.runtime.acceptEvent(completion); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  test("ordinary follow-up retains active authorization, withdraws only stale automation, and continues after the user's own boundary", async () => {
    const f = fixture();
    try {
      await f.create(); const prior = await f.runtime.start(sessionID);
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_followup" });
      let state = await f.get();
      expect(state.current).toMatchObject({ status: "active", reason: null });
      expect(state.explicitStop).toBe(false);
      expect(f.bridge.cancelled).toEqual([prior.admissionId]);
      expect(state.history.filter(item => item.action === "pause")).toHaveLength(0);
      f.bridge.state.inbox.push({ id: "msg_followup", sessionID, type: "user", payload: {}, delivery: "queue", time: { created: 10_001 } });
      await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(1); // Pending user input still wins.
      f.bridge.state.inbox = []; await f.begin(); await f.idle();
      expect(f.host.admitted).toHaveLength(2);
      state = await f.get();
      expect(state.allowance.usage.autoTurns).toBe(2);
      expect(f.host.admitted[1]!.id).not.toBe(prior.admissionId);
      expect(state.current!.status).toBe("active");
    } finally { await f.runtime.dispose(); }
  });

  test("healthy restart observation reconciles an exact outstanding ID and automatically admits one new charged ID", async () => {
    const store = new Store(); const first = fixture(false, store);
    await first.create(); const prior = await first.runtime.start(sessionID); await first.runtime.dispose();
    const second = fixture(true, store); second.bridge.state.inbox = structuredClone(first.bridge.state.inbox);
    try {
      const observed = await second.get();
      expect(observed.current).toMatchObject({ status: "paused", reason: "restart" });
      await second.runtime.drain();
      expect(second.bridge.cancelled).toEqual([prior.admissionId]);
      expect(second.host.admitted).toHaveLength(1);
      expect(second.host.admitted[0]!.id).not.toBe(prior.admissionId);
      expect((await second.get()).allowance.usage.autoTurns).toBe(2);
      await second.runtime.drain(); expect(second.host.admitted).toHaveLength(1);
    } finally { await second.runtime.dispose(); }
  });

  for (const stop of ["pause", "block", "cancel"] as const) {
    for (const legacy of [false, true]) {
      test(`${stop} plus outstanding dispatch remains stopped across reload (${legacy ? "legacy" : "explicit metadata"})`, async () => {
        const store = new Store(); const first = fixture(false, store);
        const created = await first.create(); await first.runtime.start(sessionID);
        await first.runtime.manage(stop, sessionID, { ...target(created), ...(stop === "block" ? { blocker: "Credentials unavailable" } : {}) }, agentSource);
        await first.runtime.dispose();
        if (legacy) for (const [key, value] of store.values) {
          const old = structuredClone(value) as unknown as SessionEnvelope; delete old.explicitStop;
          // Simulate the old buggy reload rewriting pause/block to restart.
          if (stop !== "cancel") { old.current!.status = "paused"; old.current!.reason = "restart"; old.current!.detail = "Legacy restart overwrite"; old.safetyPause = { reason: "restart", detail: "Legacy restart overwrite" }; }
          store.values.set(key, old as never);
        }
        const second = fixture(true, store);
        const stored = [...store.values.values()][0] as unknown as SessionEnvelope;
        // Supply otherwise sufficient delivery proof: only stop intent should
        // prevent legacy restart recovery, not an accidentally missing message.
        second.host.messages.push({ id: stored.dispatch!.id, type: "user", created: 10_000 });
        try {
          const held = await second.get(); await second.runtime.drain();
          expect(held.explicitStop).toBe(true);
          expect((await second.get()).current!.status).toBe(stop === "cancel" ? "cancelled" : stop === "block" && !legacy ? "blocked" : "paused");
          expect(second.host.promptAttempts).toBe(0);
          expect((await second.get()).allowance.usage.autoTurns).toBe(1);
        } finally { await second.runtime.dispose(); }
      });
    }
  }

  test("no-progress restatements and duplicate evidence stay held; new substantive evidence safely clears only that window", async () => {
    const f = fixture();
    try {
      let held = await noProgressGoal(f);
      held = (await f.runtime.manage("checkpoint", sessionID, { ...target(held), summary: "Still waiting on the same work", evidence: "Initial focused test passed" }, agentSource))!;
      await f.runtime.drain();
      expect((await f.get()).current!.reason).toBe("no_progress");
      expect(await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      const limits = structuredClone(held.allowance.limits);
      await f.runtime.manage("evidence", sessionID, { ...target(held), criterionId: "accept", evidence: { summary: "Focused regression passed against the integrated implementation", reference: "bun test recovery" } }, agentSource);
      await f.runtime.drain();
      const recovered = await f.get();
      expect(recovered.current!.status).toBe("active");
      expect(recovered.allowance.usage.autoTurns).toBe(3);
      expect(recovered.allowance.limits).toEqual(limits);
      // A start advances dispatchProgress, so clearing the real progress window
      // before that baseline is essential: the next idle must not instantly pause.
      const prior = f.host.admitted.at(-1)!; f.bridge.state.inbox = [];
      f.host.messages.push({ id: prior.id, type: "user", created: 10_000 });
      await f.begin(); await f.idle();
      expect((await f.get()).current).toMatchObject({ status: "active", noProgress: 1 });
      expect(f.host.admitted).toHaveLength(4);
    } finally { await f.runtime.dispose(); }
  });

  for (const stop of ["pause", "cancel", "block", "user", "move", "dispose", "observation"] as const) {
    test(`${stop} fences scheduled active-turn recovery before idle without charging`, async () => {
      const f = fixture();
      try {
        const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
        await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
        if (stop === "user") await f.runtime.guardPrompt({ sessionID, messageID: "msg_newer" });
        else if (stop === "move") { f.emit("session.moved"); await f.runtime.drain(); }
        else if (stop === "dispose") await f.runtime.dispose();
        else if (stop === "observation") {
          const written = deferred(); f.store.onWrite = value => { if ((value as SessionEnvelope).current?.reason === "runtime_failure") written.resolve(); };
          f.host.streamFailure.resolve(); await written.promise;
        } else if (stop === "block") {
          await f.runtime.manage("block", sessionID, { ...target(held), blocker: "Credentials unavailable" }, agentSource);
        } else await f.runtime.manage(stop, sessionID, target(held), agentSource);
        f.bridge.state.active = false; await f.idle();
        expect(f.host.promptAttempts).toBe(0);
        expect(([...f.store.values.values()][0] as unknown as SessionEnvelope).allowance.usage.autoTurns).toBe(0);
      } finally { await f.runtime.dispose(); }
    });
  }

  for (const gate of ["permission", "form", "foreign", "restricted", "owner", "bridge"] as const) {
    test(`${gate} blocks deferred recovery at the fresh boundary`, async () => {
      const f = fixture();
      try {
        const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
        await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
        if (gate === "permission") f.host.pendingPermissions = [{ id: "per_wait" }];
        if (gate === "form") f.bridge.state.forms = [{ id: "frm_wait", sessionID }];
        if (gate === "foreign") f.bridge.state.inbox = [{ id: "msg_wait", sessionID, type: "user", payload: {}, delivery: "queue", time: { created: 10_001 } }];
        if (gate === "restricted") f.host.session.agent = "plan";
        if (gate === "owner") f.owner.held = false;
        if (gate === "bridge") f.bridge.failure = new BridgeError("identity");
        f.bridge.state.active = false; await f.idle();
        expect(f.host.promptAttempts).toBe(0);
        expect(([...f.store.values.values()][0] as unknown as SessionEnvelope).allowance.usage.autoTurns).toBe(0);
      } finally { f.owner.held = true; await f.runtime.dispose(); }
    });
  }

  test("unknown old delivery is not proved by an unrelated successful idle", async () => {
    const store = new Store(); const first = fixture(false, store);
    await first.create(); const prior = await first.runtime.start(sessionID); await first.runtime.dispose();
    const second = fixture(true, store);
    try {
      await second.get(); await second.runtime.drain();
      await second.begin(); await second.idle();
      expect(second.host.promptAttempts).toBe(0);
      const held = await second.get();
      expect(held.current!.status).toBe("paused");
      expect(held.dispatch!.id).toBe(prior.admissionId);
      expect(held.allowance.usage.autoTurns).toBe(1);
    } finally { await second.runtime.dispose(); }
  });

  test("failed execution is not automatically retried by reads, but a new user-authorized turn may recover", async () => {
    const f = fixture();
    try {
      await failedGoal(f); await f.get(); await f.runtime.context(sessionID, "build"); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_new_authorization" });
      f.host.messages.push({ id: "msg_new_authorization", type: "user", created: 10_050 });
      f.bridge.state.active = true; await f.begin(); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      f.bridge.state.active = false; await f.idle();
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("autoContinue disabled keeps deferred agent recovery bookkeeping-only", async () => {
    const f = fixture(false);
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
      f.bridge.state.active = false; await f.idle();
      expect((await f.get()).current!.status).toBe("active");
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("a transient runtime failure recovers on a later healthy native usage observation, without a resume tool", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin(); f.bridge.failure = new BridgeError("identity"); await f.idle();
      expect((await f.get()).current!.reason).toBe("runtime_failure");
      await f.runtime.drain(); expect(f.host.promptAttempts).toBe(0);
      f.bridge.failure = undefined; f.emit("session.usage.updated"); await f.runtime.drain();
      expect((await f.get()).current!.status).toBe("active");
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  test("newer user input during a recovery inspection fences the stale result, not just its initial request", async () => {
    const f = fixture(); const inspecting = deferred(); const release = deferred();
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
      f.bridge.beforeInspect = async () => { f.bridge.beforeInspect = undefined; inspecting.resolve(); await release.promise; };
      f.bridge.state.active = false; f.succeed(); await inspecting.promise;
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_priority_race" });
      release.resolve(); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("a terminal event racing an active recovery snapshot is coalesced but not lost", async () => {
    const f = fixture(); const inspecting = deferred(); const release = deferred();
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      // The first inspection belongs to the public tool. Gate only its deferred worker.
      let inspections = 0;
      f.bridge.beforeInspect = async () => { if (++inspections === 2) { f.bridge.beforeInspect = undefined; inspecting.resolve(); await release.promise; } };
      const requested = await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource);
      expect(requested.ok).toBe(true);
      await inspecting.promise;
      f.bridge.state.active = false; f.succeed(); release.resolve(); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("legacy budget hold defers explicit active-turn recovery without refund or automatic wake", async () => {
    const f = fixture();
    try {
      await f.create();
      await f.runtime.start(sessionID); const held = await legacyBudgetHold(f, await f.get());
      expect(held.current!.reason).toBe("budget");
      f.bridge.state.active = true;
      expect(await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource)).toMatchObject({ ok: true, diagnostics: { recovery: "scheduled" } });
      await f.runtime.drain();
      const stillHeld = await f.get();
      expect(stillHeld.current).toMatchObject({ status: "paused", reason: "budget", limits: null, usage: { autoTurns: 1 } });
      expect(f.runtime.diagnostics(sessionID).recovery).toBe("waiting");
      expect(stillHeld.allowance.limits).toEqual(held.allowance.limits);
      expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("automatic ambiguity recovery requires exact delivery proof, then retires the old ID without replay or refund", async () => {
    const f = fixture();
    try {
      await f.create(); await f.begin();
      const prompt = f.host.prompt.bind(f.host);
      f.host.prompt = async (...args) => { await prompt(...args); throw new Error("Response lost after native admission"); };
      // Delivery wins the DELETE race. Native returns 204 but emits no cancelled
      // event; the context projection is deliberately withheld until below.
      f.bridge.beforeCancel = async () => { f.bridge.state.inbox = []; };
      await f.idle();
      const uncertain = await f.get(); await f.runtime.drain();
      expect(uncertain.current!.reason).toBe("ambiguous");
      expect(uncertain.dispatch).not.toBeNull();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
      f.host.prompt = prompt;
      f.host.messages.push({ id: uncertain.dispatch!.id, type: "user", created: 10_020 });
      f.emit("session.usage.updated"); await f.runtime.drain();
      const recovered = await f.get();
      expect(recovered.current!.status).toBe("active");
      expect(f.host.admitted).toHaveLength(2);
      expect(f.host.admitted[1]!.id).not.toBe(uncertain.dispatch!.id);
      expect(recovered.allowance.usage.autoTurns).toBe(2);
    } finally { await f.runtime.dispose(); }
  });

  for (const outcome of ["failed", "interrupted"] as const) {
    test(`${outcome} with an outstanding dispatch remains held across reload, even when delivery is proved`, async () => {
      const store = new Store(); const first = fixture(false, store);
      await first.create(); const prior = await first.runtime.start(sessionID);
      await first.begin(); first.emit(`session.execution.${outcome}`); await first.runtime.drain(); await first.runtime.dispose();
      const second = fixture(true, store);
      second.host.messages.push({ id: prior.admissionId, type: "user", created: 10_000 });
      try {
        const held = await second.get(); await second.runtime.drain();
        expect(held.current).toMatchObject({ status: "paused", reason: outcome });
        expect(second.host.promptAttempts).toBe(0);
        expect((await second.get()).allowance.usage.autoTurns).toBe(1);
      } finally { await second.runtime.dispose(); }
    });
  }

  test("an explicit pause aborts recovery's post-terminal native wait without waiting for unrelated execution", async () => {
    const f = fixture(); const waiting = deferred(); const release = deferred();
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
      f.host.beforeIdle = async () => { waiting.resolve(); await release.promise; };
      f.succeed(); await waiting.promise;
      await f.runtime.manage("pause", sessionID, target(held), agentSource);
      await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).explicitStop).toBe(true);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("deliberate deferred command recovery still starts once with autoContinue disabled", async () => {
    const f = fixture(false);
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, { kind: "human", commandStart: true });
      await f.runtime.drain(); expect(f.host.promptAttempts).toBe(0);
      f.bridge.state.active = false; await f.idle();
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.admitted[0]!.metadata).toMatchObject({ goals: { kind: "start" } });
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
      f.emit("session.execution.succeeded"); await f.runtime.drain(); expect(f.host.admitted).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  test("background work arriving after resume but before reservation preserves an uncharged pending handoff", async () => {
    const f = fixture();
    try {
      const held = await failedGoal(f); await f.begin(); f.bridge.state.active = true;
      await f.runtime.manage("resume", sessionID, { ...target(held), recover: true }, agentSource); await f.runtime.drain();
      f.store.onWrite = value => {
        if ((value as SessionEnvelope).history.at(-1)?.action === "resume") { f.store.onWrite = undefined; f.bridge.jobs.shells = ["sh_after_resume"]; }
      };
      f.bridge.state.active = false; await f.idle();
      const waiting = await f.get();
      expect(waiting.current!.status).toBe("active");
      expect(waiting.allowance.usage.autoTurns).toBe(0);
      expect(waiting.dispatch).toBeNull();
      expect(f.host.promptAttempts).toBe(0);
      f.bridge.jobs.shells = [];
      f.runtime.acceptEvent({ type: "shell.exited", created: 10_200, data: { id: "sh_after_resume", status: "exited" } });
      await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect((await f.get()).allowance.usage.autoTurns).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  test("recording a blocker cannot relabel a stagnant window into a recoverable bypass", async () => {
    const f = fixture();
    try {
      const held = await noProgressGoal(f);
      const blocked = (await f.runtime.manage("block", sessionID, { ...target(held), blocker: "Waiting on external verification" }, agentSource))!;
      expect(blocked.current!.status).toBe("blocked");
      expect(blocked.safetyPause!.reason).toBe("no_progress");
      f.bridge.state.active = true;
      expect(await f.runtime.call("resume", sessionID, { ...target(blocked), recover: true }, agentSource)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      await f.runtime.drain();
      expect((await f.get()).current!.status).toBe("blocked");
      expect((await f.get()).allowance.usage.autoTurns).toBe(2);
    } finally { await f.runtime.dispose(); }
  });

  test("a foreign synthetic input is not fresh user authorization to retry failed work", async () => {
    const f = fixture();
    try {
      await failedGoal(f);
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_foreign_automation" });
      f.host.messages.push({ id: "msg_foreign_automation", type: "synthetic", created: 10_050 });
      f.bridge.state.active = true; await f.begin(); await f.runtime.drain();
      f.bridge.state.active = false; await f.idle();
      expect((await f.get()).current).toMatchObject({ status: "paused", reason: "failed" });
      expect(f.host.promptAttempts).toBe(0);
      expect((await f.get()).allowance.usage.autoTurns).toBe(0);
    } finally { await f.runtime.dispose(); }
  });
});

describe("committed cancellation proof", () => {
  async function restartedWithQueuedDispatch() {
    const store = new Store(); const first = fixture(false, store);
    await first.create(); const prior = await first.runtime.start(sessionID); await first.runtime.dispose();
    const next = fixture(true, store);
    next.bridge.state.inbox = structuredClone(first.bridge.state.inbox);
    return { next, prior };
  }
  const humanSnapshot = (f: ReturnType<typeof fixture>) => f.runtime.manage("get", sessionID, {}, { kind: "human" }) as Promise<SessionEnvelope>;
  const delivered = (f: ReturnType<typeof fixture>, inboxID: string) => f.runtime.acceptEvent({
    type: "session.inbox.delivered", created: 10_200, data: { sessionID, inboxID },
  });

  test("pre-presence plus no-op 204 and absence cannot prove withdrawal; only exact delivered context releases the hold", async () => {
    const { next: f, prior } = await restartedWithQueuedDispatch();
    let cancellationCommits = 0;
    try {
      f.bridge.beforeCancel = async () => { f.bridge.state.inbox = []; }; // Delivery wins the serialized transaction.
      f.bridge.onCancelled = () => { cancellationCommits++; };
      const held = await f.get(); await f.runtime.drain();
      expect(f.bridge.cancelled).toEqual([prior.admissionId]);
      expect(cancellationCommits).toBe(0);
      expect((await humanSnapshot(f)).dispatch!.id).toBe(prior.admissionId);
      expect((await humanSnapshot(f)).current!.status).toBe("paused");
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(1);
      expect(f.host.promptAttempts).toBe(0);
      const request = await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource);
      expect(request).toMatchObject({ ok: true, current: { status: "paused" }, diagnostics: { recovery: "waiting" } });
      await f.runtime.drain(); expect(f.host.waitCalls).toBe(0);
      // A matching delivery notification is a wakeup, NOT proof when context is missing.
      delivered(f, prior.admissionId); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      await f.begin(); await f.idle(); // Even a later successful native idle is not exact-ID proof.
      expect((await humanSnapshot(f)).dispatch!.id).toBe(prior.admissionId);
      expect(f.host.promptAttempts).toBe(0);
      f.host.messages.push({ id: prior.admissionId, type: "user", created: 10_020 });
      delivered(f, prior.admissionId); delivered(f, prior.admissionId); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(1);
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.admitted[0]!.id).not.toBe(prior.admissionId);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(2);
      expect((await humanSnapshot(f)).current!.status).toBe("active");
    } finally { await f.runtime.dispose(); }
  });

  test("delayed exact committed cancellation resumes once; unrelated session/ID events and duplicate confirmations cannot admit", async () => {
    const { next: f, prior } = await restartedWithQueuedDispatch();
    let confirmation: unknown;
    try {
      f.bridge.onCancelled = (id, inboxID) => { confirmation = f.cancellationEvent(id, inboxID); };
      const held = await f.get(); await f.runtime.drain();
      expect(confirmation).toBeDefined();
      expect(f.bridge.state.inbox).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(1);
      expect(await f.runtime.call("resume", sessionID, { ...target(held), recover: true }, agentSource))
        .toMatchObject({ ok: true, current: { status: "paused" }, diagnostics: { recovery: "waiting" } });
      f.runtime.acceptEvent(f.cancellationEvent("ses_foreign", prior.admissionId));
      f.runtime.acceptEvent(f.cancellationEvent(sessionID, "msg_unowned")); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(0);
      expect((await humanSnapshot(f)).dispatch!.id).toBe(prior.admissionId);
      f.runtime.acceptEvent(confirmation); f.runtime.acceptEvent(confirmation); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(1);
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.admitted[0]!.id).not.toBe(prior.admissionId);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(2);
      f.runtime.acceptEvent(confirmation); await f.runtime.drain();
      expect(f.host.promptAttempts).toBe(1);
      expect(f.bridge.cancelled).toEqual([prior.admissionId]);
    } finally { await f.runtime.dispose(); }
  });

  test("committed cancellation before DELETE response is sticky, not lost or inferred from the response", async () => {
    const { next: f, prior } = await restartedWithQueuedDispatch();
    const committed = deferred(); const response = deferred();
    try {
      f.bridge.afterCancel = async () => { committed.resolve(); await response.promise; };
      const observing = f.get(); await committed.promise;
      expect(f.bridge.state.inbox).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
      response.resolve(); await observing; await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.admitted[0]!.id).not.toBe(prior.admissionId);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(2);
    } finally { response.resolve(); await f.runtime.dispose(); }
  });

  test("ordinary follow-up retains its successful active candidate until delayed committed proof arrives", async () => {
    const f = fixture(); let confirmation: unknown;
    try {
      await f.create(); const prior = await f.runtime.start(sessionID);
      f.bridge.onCancelled = (id, inboxID) => { confirmation = f.cancellationEvent(id, inboxID); };
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_real_followup" });
      await f.begin(); await f.idle();
      expect((await humanSnapshot(f)).current).toMatchObject({ status: "active", reason: null });
      expect((await humanSnapshot(f)).dispatch!.id).toBe(prior.admissionId);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(1);
      expect(f.host.promptAttempts).toBe(1);
      expect(confirmation).toBeDefined();
      f.runtime.acceptEvent(confirmation); f.runtime.acceptEvent(confirmation); await f.runtime.drain();
      expect(f.host.admitted).toHaveLength(2);
      expect(f.host.admitted[1]!.id).not.toBe(prior.admissionId);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(2);
      expect((await humanSnapshot(f)).current!.status).toBe("active");
    } finally { await f.runtime.dispose(); }
  });

  test("delivery notification racing a stale context read causes one fresh proof check without polling", async () => {
    const { next: f, prior } = await restartedWithQueuedDispatch();
    try {
      f.bridge.beforeCancel = async () => { f.bridge.state.inbox = []; };
      let contextReads = 0;
      f.host.beforeContext = async () => {
        contextReads++;
        if (contextReads === 1) {
          f.host.messages.push({ id: prior.admissionId, type: "synthetic", created: 10_020 });
          delivered(f, prior.admissionId);
        }
      };
      await f.get(); await f.runtime.drain();
      expect(contextReads).toBe(2);
      expect(f.host.admitted).toHaveLength(1);
      expect(f.host.admitted[0]!.id).not.toBe(prior.admissionId);
      expect((await humanSnapshot(f)).allowance.usage.autoTurns).toBe(2);
    } finally { await f.runtime.dispose(); }
  });

  for (const stop of ["pause", "block", "cancel", "user", "move", "owner", "dispose", "observation"] as const) {
    test(`${stop} fences delayed committed confirmation without refunding the old reservation`, async () => {
      const { next: f, prior } = await restartedWithQueuedDispatch(); let confirmation: unknown;
      try {
        f.bridge.onCancelled = (id, inboxID) => { confirmation = f.cancellationEvent(id, inboxID); };
        const held = await f.get(); await f.runtime.drain();
        if (stop === "user") await f.runtime.guardPrompt({ sessionID, messageID: "msg_newer_user" });
        else if (stop === "move") { f.emit("session.moved"); await f.runtime.drain(); }
        else if (stop === "owner") f.owner.held = false;
        else if (stop === "dispose") await f.runtime.dispose();
        else if (stop === "observation") {
          const persisted = deferred(); f.store.onWrite = value => { if ((value as SessionEnvelope).current?.reason === "runtime_failure") persisted.resolve(); };
          f.host.streamFailure.resolve(); await persisted.promise;
        } else await f.runtime.manage(stop, sessionID, { ...target(held), ...(stop === "block" ? { blocker: "Credentials unavailable" } : {}) }, agentSource);
        expect(confirmation).toBeDefined();
        f.runtime.acceptEvent(confirmation); await f.runtime.drain();
        expect(f.host.promptAttempts).toBe(0);
        const stored = [...f.store.values.values()][0] as unknown as SessionEnvelope;
        expect(stored.allowance.usage.autoTurns).toBe(1);
        expect(stored.dispatch!.id).toBe(prior.admissionId);
      } finally { f.owner.held = true; await f.runtime.dispose(); }
    });
  }

  for (const legacy of [false, true]) {
    test(`failed hold with outstanding dispatch plus explicit pause survives reload and exact delivery (${legacy ? "legacy" : "metadata"})`, async () => {
      const store = new Store(); const first = fixture(false, store);
      await first.create(); const prior = await first.runtime.start(sessionID);
      await first.begin(); first.emit("session.execution.failed"); await first.runtime.drain();
      const failed = await first.get(); expect(failed.current!.reason).toBe("failed");
      await first.runtime.manage("pause", sessionID, target(failed), agentSource); await first.runtime.dispose();
      if (legacy) for (const [key, value] of store.values) {
        const old = structuredClone(value) as unknown as SessionEnvelope; delete old.explicitStop;
        old.current!.reason = "restart"; old.current!.detail = "Old runtime overwrote the failed pause";
        old.safetyPause = { reason: "restart", detail: "Old runtime overwrote the failed pause" };
        store.values.set(key, old as never);
      }
      const second = fixture(true, store);
      second.host.messages.push({ id: prior.admissionId, type: "user", created: 10_000 });
      try {
        await second.get(); await second.runtime.drain();
        const held = await humanSnapshot(second);
        expect(held.explicitStop).toBe(true);
        expect(held.current!.status).toBe("paused");
        expect(held.current!.reason).toBe(legacy ? "restart" : "failed");
        expect(held.allowance.usage.autoTurns).toBe(1);
        expect(second.host.promptAttempts).toBe(0);
      } finally { await second.runtime.dispose(); }
    });
  }

  test("new user authorization tracking fails closed at its fixed 128-session bound", async () => {
    const f = fixture();
    try {
      f.host.getSession = async id => ({ ...structuredClone(f.host.session), id: id ?? sessionID });
      for (let index = 0; index < 128; index++) await f.runtime.guardPrompt({ sessionID: `ses_user_${index}`, messageID: `msg_user_${index}` });
      expect(f.runtime.diagnostics().events).toBe("observing");
      await f.runtime.guardPrompt({ sessionID: "ses_user_overflow", messageID: "msg_user_overflow" });
      expect(f.runtime.diagnostics().events).toBe("failed");
      expect(f.host.promptAttempts).toBe(0);
      expect(f.store.values.size).toBe(0);
    } finally { await f.runtime.dispose(); }
  });
});

describe("disposed runtime capture contract", () => {
  const disposedNotice = /reload|unavailable/i;

  test("disposed_contextCallback_returnsPolicyNoticeWithoutStoredGoal", async () => {
    const f = fixture(false);
    try {
      await f.create();
      // Allowed live case first: a working hook renders stored task context.
      const live = await f.runtime.context(sessionID, "build");
      expect(live).toContain(POLICY);
      expect(live).toContain("Deliver authorized behavior");
      const writesBefore = f.store.values.size;
      await f.runtime.dispose();
      const rendered = await f.runtime.context(sessionID, "build");
      expect(rendered).toContain(POLICY);
      expect(rendered).toMatch(disposedNotice);
      expect(rendered).not.toContain("Deliver authorized behavior");
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_compactionCallback_returnsPolicyNoticeWithoutStoredGoal", async () => {
    const f = fixture(false);
    try {
      await f.create();
      const live = await f.runtime.context(sessionID, "build", false);
      expect(live).toContain(POLICY);
      expect(live).toContain("Deliver authorized behavior");
      await f.runtime.dispose();
      const rendered = await f.runtime.context(sessionID, "build", false);
      expect(rendered).toContain(POLICY);
      expect(rendered).toMatch(disposedNotice);
      expect(rendered).not.toContain("Deliver authorized behavior");
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_contextInFlightAtHostSessionRead_resolvesPolicyNotice", async () => {
    const f = fixture(false); const entered = deferred(); const release = deferred();
    try {
      await f.create();
      expect(await f.runtime.context(sessionID, "build")).toContain("Deliver authorized behavior");
      const originalGetSession = f.host.getSession.bind(f.host);
      let gated = true;
      f.host.getSession = (async (id?: string) => {
        if (gated) { gated = false; entered.resolve(); await release.promise; }
        return originalGetSession(id);
      }) as typeof f.host.getSession;
      const pending = f.runtime.context(sessionID, "build");
      await entered.promise;
      const writesBefore = f.store.values.size;
      const disposing = f.runtime.dispose();
      release.resolve();
      await disposing;
      const rendered = await pending;
      expect(rendered).toContain(POLICY);
      expect(rendered).toMatch(disposedNotice);
      expect(rendered).not.toContain("Deliver authorized behavior");
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("disposed_contextInFlightAtStoreRead_resolvesPolicyNotice", async () => {
    const f = fixture(false); const entered = deferred(); const release = deferred();
    try {
      await f.create();
      expect(await f.runtime.context(sessionID, "build")).toContain("Deliver authorized behavior");
      let gated = true;
      f.store.beforeRead = async () => { if (gated) { gated = false; entered.resolve(); await release.promise; } };
      const pending = f.runtime.context(sessionID, "build");
      await entered.promise;
      const writesBefore = f.store.values.size;
      const disposing = f.runtime.dispose();
      release.resolve();
      await disposing;
      const rendered = await pending;
      expect(rendered).toContain(POLICY);
      expect(rendered).toMatch(disposedNotice);
      expect(rendered).not.toContain("Deliver authorized behavior");
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("disposed_unrelatedGuardPrompt_noopsWithoutWrites", async () => {
    const f = fixture(false);
    try {
      // Allowed live case first: unrelated user input yields without throwing.
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_live_user" });
      await f.create();
      const writesBefore = f.store.values.size;
      const admittedBefore = f.host.admitted.length;
      const promptsBefore = f.host.promptAttempts;
      await f.runtime.dispose();
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_unrelated_user" });
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(admittedBefore);
      expect(f.host.promptAttempts).toBe(promptsBefore);
      expect(f.host.notices).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_unrelatedGuardPromptInFlightAtOwner_noopsWithoutWrites", async () => {
    const f = fixture(false); const entered = deferred(); const release = deferred();
    try {
      await f.create();
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_live_user" });
      const originalAssertOwned = f.owner.assertOwned.bind(f.owner);
      let gated = true;
      f.owner.assertOwned = async () => { if (gated) { gated = false; entered.resolve(); await release.promise; } return originalAssertOwned(); };
      const pending = f.runtime.guardPrompt({ sessionID, messageID: "msg_racing_user" });
      await entered.promise;
      const writesBefore = f.store.values.size;
      const disposing = f.runtime.dispose();
      release.resolve();
      await disposing;
      await pending;
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("disposed_unrelatedGuardPromptInFlightAtStoreRead_noopsWithoutWrites", async () => {
    const f = fixture(false); const entered = deferred(); const release = deferred();
    try {
      await f.create();
      await f.runtime.guardPrompt({ sessionID, messageID: "msg_live_user" });
      let gated = true;
      f.store.beforeRead = async () => { if (gated) { gated = false; entered.resolve(); await release.promise; } };
      const pending = f.runtime.guardPrompt({ sessionID, messageID: "msg_racing_store_user" });
      await entered.promise;
      const writesBefore = f.store.values.size;
      const disposing = f.runtime.dispose();
      release.resolve();
      await disposing;
      await pending;
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
      expect(f.host.notices).toHaveLength(0);
    } finally { release.resolve(); await f.runtime.dispose(); }
  });

  test("disposed_taggedAdmission_stillRejectsWithoutAdmission", async () => {
    const f = fixture(false);
    try {
      await f.create();
      await f.runtime.dispose();
      await expect(f.runtime.guardPrompt({
        sessionID, messageID: "msg_stale_owned",
        metadata: { goals: { source: "opencode-goals", kind: "continue", owner: "stale-owner", id: "msg_stale_owned", goalId: "goal_stale", generation: 0 } },
      })).rejects.toMatchObject({ code: "disposed" });
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_manage_staysStrict", async () => {
    const f = fixture(false);
    try {
      await f.create();
      const writesBefore = f.store.values.size;
      await f.runtime.dispose();
      await expect(f.runtime.manage("get", sessionID, {}, agentSource)).rejects.toMatchObject({ code: "disposed" });
      expect(f.store.values.size).toBe(writesBefore);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_publicCall_returnsDisposedResultWithoutWrites", async () => {
    const f = fixture(false);
    try {
      await f.create();
      const live = await f.runtime.call("get", sessionID, {}, agentSource);
      expect(live.ok).toBe(true);
      const writesBefore = f.store.values.size;
      await f.runtime.dispose();
      const result = await f.runtime.call("get", sessionID, {}, agentSource);
      expect(result).toMatchObject({ ok: false, error: { code: "disposed" } });
      expect(PublicResultSchema.safeParse(result).success).toBe(true);
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.admitted).toHaveLength(0);
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_capturedToolExecutor_returnsDisposedResult", async () => {
    const f = fixture(false);
    const tools: { name: string; execute: (input: unknown, context: unknown) => Promise<{ output: unknown; content: string }> }[] = [];
    const ctx = { tool: { transform: async (callback: (editor: unknown) => void) => callback({ namespace() {}, add(tool: (typeof tools)[number]) { tools.push(tool); } }) } } as unknown as Plugin.Context;
    try {
      await registerTools(ctx, f.runtime);
      const create = tools.find(t => t.name === "create")!;
      const context = { sessionID, agent: "build", signal: new AbortController().signal };
      const created = await create.execute(input, context);
      expect(created.output).toMatchObject({ ok: true });
      const writesBefore = f.store.values.size;
      await f.runtime.dispose();
      const after = await create.execute(input, context);
      expect(after.output).toMatchObject({ ok: false, error: { code: "disposed" } });
      expect(PublicResultSchema.safeParse(after.output).success).toBe(true);
      expect(JSON.parse(after.content)).toEqual(after.output);
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  test("disposed_rpcHandler_returnsDisposedResult", async () => {
    const f = fixture(false);
    let handlers: Record<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>> = {};
    const ctx = { rpc: { register: async (_definition: unknown, registered: typeof handlers) => { handlers = registered; } } } as unknown as Plugin.Context;
    try {
      await registerRPC(ctx, f.runtime);
      expect(await handlers.get({ sessionID }, { signal: new AbortController().signal })).toMatchObject({ ok: true });
      const writesBefore = f.store.values.size;
      await f.runtime.dispose();
      const result = await handlers.get({ sessionID }, { signal: new AbortController().signal });
      expect(result).toMatchObject({ ok: false, error: { code: "disposed" } });
      expect(PublicResultSchema.safeParse(result).success).toBe(true);
      expect(f.store.values.size).toBe(writesBefore);
      expect(f.host.promptAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });
});
