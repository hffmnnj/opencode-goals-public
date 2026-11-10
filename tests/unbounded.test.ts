import { describe, expect, test } from "bun:test";
import { GoalService, type GoalAccess, type GoalStorage } from "../src/service.ts";
import { ConfigSchema, EnvelopeSchema, StoredEnvelopeSchema, sessionStorageKey, type GoalConfigInput, type SessionEnvelope } from "../src/schema.ts";
import { legacyEnvelope, legacyGoalLimits, legacySessionLimits } from "./fixtures/legacy-envelope.ts";

class Store implements GoalStorage {
  values = new Map<string, Parameters<GoalStorage["set"]>[1]>();
  writes = 0;
  failWrite = false;
  async get(key: string) { return structuredClone(this.values.get(key)); }
  async set(key: string, value: Parameters<GoalStorage["set"]>[1]) {
    this.writes++;
    if (this.failWrite) throw new Error("Fixture migration failure");
    this.values.set(key, structuredClone(value));
  }
}
const agent: GoalAccess = { actor: { kind: "agent", id: "build" }, executionAllowed: true };
const recovered = { ...agent, trustedRecovery: true, explicitResume: true };
const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const input = { sessionID: "ses_unbounded", objective: "Deliver authorized work", criteria: [{ id: "accept", description: "Observable behavior verified" }], tokens: zero };
const key = sessionStorageKey("/unbounded", input.sessionID);
const tiny = { maxAutoTurns: 1, maxDurationSeconds: 1, tokenBudget: 1 };
const target = (s: SessionEnvelope) => ({ sessionID: s.sessionID, goalId: s.current!.id, expectedRevision: s.current!.revision });
function fixture(config: GoalConfigInput = {}) {
  const store = new Store(); let time = 10_000; let sequence = 0;
  const create = () => new GoalService({ storage: store, location: "/unbounded", owner: "fixture", config,
    now: () => time, uuid: () => String(++sequence) });
  return { store, service: create(), restart: create, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe("ceiling-free state and execution", () => {
  for (const config of [{}, { goalLimits: tiny, sessionLimits: tiny }]) {
    test(`new state has null limits and ignores legacy configuration ${JSON.stringify(config)}`, async () => {
      const f = fixture(config);
      const created = await f.service.create(input, agent);
      expect(created).toMatchObject({ schemaVersion: 2, current: { limits: null }, allowance: { limits: null } });
      expect(EnvelopeSchema.parse(JSON.parse(JSON.stringify(await f.store.get(key)))).current!.limits).toBeNull();
      f.advance(700_000_000);
      const observed = await f.service.observeUsage(input.sessionID, { ...zero, input: 120_000_001 });
      expect(observed.current).toMatchObject({ status: "active", reason: null,
        usage: { autoTurns: 0, activeSeconds: 700_000, tokens: 120_000_001 } });
      expect(observed.allowance.usage).toEqual(observed.current!.usage);
      expect(observed.history).toEqual(created.history);
      expect(f.service.config.maxNoProgress).toBe(2);
    });
  }

  test("legacy high usage migrates, resumes, starts and continues beyond ALL former goal and session thresholds", async () => {
    const f = fixture({ autoContinue: true, goalLimits: tiny, sessionLimits: tiny });
    let s = await f.service.create(input, agent);
    s = await f.service.recordEvidence({ ...target(s), criterionId: "accept", evidence: { summary: "Existing verified milestone" } }, agent);
    s = await f.service.pause(target(s), agent);
    const old = legacyEnvelope(s);
    old.current!.usage = { autoTurns: 1200, activeSeconds: 700_000, tokens: 120_000_000 };
    old.allowance.usage = { autoTurns: 1800, activeSeconds: 900_000, tokens: 150_000_000 };
    old.highWater = { input: 120_000_000, output: 10_000_000, reasoning: 5_000_000, cache: { read: 10_000_000, write: 5_000_000 } };
    const usage = structuredClone(old.current!.usage); const sessionUsage = structuredClone(old.allowance.usage);
    f.store.values.set(key, old);
    const service = f.restart(); s = (await service.get(input.sessionID))!;
    expect(s.current!.usage).toEqual(usage); expect(s.allowance.usage).toEqual(sessionUsage);
    expect(s.highWater).toEqual(old.highWater);
    expect(s.current!.criteria).toEqual(old.current!.criteria);
    expect(s.current!.id).toBe(old.current!.id);
    s = await service.resume({ ...target(s), tokens: old.highWater }, agent);
    s = await service.reserveStart({ sessionID: s.sessionID, goalId: s.current!.id, generation: s.current!.generation, tokens: old.highWater }, agent);
    expect(s.current!.usage.autoTurns).toBe(1201); expect(s.allowance.usage.autoTurns).toBe(1801);
    s = (await service.acknowledgeDispatch(s.sessionID, s.dispatch!.id)).state;
    f.advance(2000);
    const result = await service.reserveDispatch({ sessionID: s.sessionID, goalId: s.current!.id, generation: s.current!.generation,
      idle: { id: "msg_next", time: f.now(), outcome: "succeeded" }, tokens: { ...old.highWater, reasoning: 5_000_007 } }, agent);
    expect(result.kind).toBe("reserved");
    expect(result.state.current).toMatchObject({ status: "active", reason: null, limits: null,
      usage: { autoTurns: 1202, activeSeconds: 700_002, tokens: 120_000_007 } });
    expect(result.state.allowance).toEqual({ limits: null, usage: { autoTurns: 1802, activeSeconds: 900_002, tokens: 150_000_007 } });
    expect(result.state.highWater).toEqual({ ...old.highWater, reasoning: 5_000_007 });
    expect(EnvelopeSchema.parse(JSON.parse(JSON.stringify(await f.store.get(key)))).schemaVersion).toBe(2);
  });

  test("no default ceilings are synthesized; v2 rejects numeric caps and stale grant setters", async () => {
    expect(ConfigSchema.parse({})).not.toHaveProperty("goalLimits");
    expect(ConfigSchema.parse({})).not.toHaveProperty("sessionLimits");
    const f = fixture(); const s = await f.service.create(input, agent);
    const fake = { ...s, current: { ...s.current, limits: legacyGoalLimits } };
    expect(EnvelopeSchema.safeParse(fake).success).toBe(false);
    expect(StoredEnvelopeSchema.safeParse(fake).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...s, allowance: { ...s.allowance, limits: legacySessionLimits } }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...s, current: { ...s.current, limitGrants: { tokenBudget: 123 } } }).success).toBe(false);
  });
});

describe("legacy preservation and hold intent", () => {
  test("migration preserves archives, historical before/after audits, high-water, scope and uncertain charged reservations", async () => {
    const f = fixture({ maxHistory: 1 }); let s = await f.service.create(input, agent);
    s = await f.service.cancel(target(s), agent);
    s = await f.service.create(input, agent);
    s = await f.service.reserveStart({ sessionID: s.sessionID, goalId: s.current!.id, generation: s.current!.generation, tokens: { ...zero, input: 12 } }, agent);
    s = await f.service.abandonDispatch(s.sessionID, s.dispatch!.id, "Unknown delivery");
    const old = legacyEnvelope(s, true);
    old.history = [0, 1].map(i => ({ goalId: s.current!.id, revision: i + 1, action: "increase_limits", reason: "Historical only", actor: agent.actor, time: i,
      limitChange: { before: { limits: legacyGoalLimits, sessionLimits: legacySessionLimits }, after: { limits: { ...legacyGoalLimits, tokenBudget: 30_000_000 }, sessionLimits: legacySessionLimits } } }));
    f.store.values.set(key, old);
    const service = f.restart(); const migrated = (await service.get(s.sessionID))!;
    expect(migrated.current!.id).toBe(old.current!.id);
    expect(migrated.current!.limits).toBeNull(); expect(migrated.archives[0]!.limits).toBeNull();
    expect(migrated.current).not.toHaveProperty("limitGrants"); expect(migrated.allowance).not.toHaveProperty("limitGrants");
    expect(migrated.highWater).toEqual(old.highWater);
    expect(migrated.allowance.usage).toEqual(old.allowance.usage);
    expect(migrated.dispatch).toEqual({ ...old.dispatch!, phase: "ambiguous" });
    // Recovery retains historical entries within the normal configured retention.
    // A representation-only migration of a held record without a dispatch retains all.
    await expect(service.resume({ ...target(migrated), tokens: zero }, recovered)).rejects.toMatchObject({ code: "dispatch_pending" });
    const held = { ...old, dispatch: null };
    f.store.values.set(key, held);
    const clean = (await f.restart().get(s.sessionID))!;
    expect(clean.history).toEqual(old.history);
    expect(clean.revision).toBe(old.revision);
    expect(await f.store.get(key)).toEqual(JSON.parse(JSON.stringify(clean)));
  });

  for (const variant of ["reason", "marker", "grants"] as const) {
    test(`legacy ${variant} hold survives safety failure and reload, then explicit reconciled resume retains usage`, async () => {
      const f = fixture(); let s = await f.service.create(input, agent);
      s = await f.service.observeUsage(s.sessionID, { ...zero, input: 12 });
      s = await f.service.pauseForSafety(s.sessionID, "runtime_failure", "Diagnostic may replace an old budget reason");
      const old = legacyEnvelope(s, variant === "grants");
      old.explicitStop = false;
      if (variant === "reason") { old.current!.reason = "budget"; old.safetyPause!.reason = "budget"; }
      f.store.values.set(key, variant === "marker" ? { ...old, budgetResumeRequired: true } : old);
      const service = f.restart(); s = (await service.get(input.sessionID))!;
      expect(s.explicitStop).toBe(true);
      const stopped = await service.pauseForSafety(s.sessionID, "runtime_failure", "A subsequent event stream failed");
      expect(stopped.explicitStop).toBe(true);
      const next = f.restart(); s = (await next.get(s.sessionID))!;
      expect(s.current!.status).toBe("paused");
      await expect(next.resume({ ...target(s), tokens: zero }, { ...agent, trustedRecovery: true })).rejects.toMatchObject({ code: "recovery_required" });
      s = await next.resume({ ...target(s), tokens: zero }, recovered);
      expect(s.current).toMatchObject({ status: "active", reason: null, limits: null, usage: { tokens: 12 } });
      expect(s.explicitStop).toBe(false); expect(s.safetyPause).toBeNull(); expect(s.highWater!.input).toBe(12);
    });
  }

  test("failed migration fences the runtime without resetting or replacing legacy state", async () => {
    const f = fixture(); let s = await f.service.create(input, agent); s = await f.service.pause(target(s), agent);
    const old = legacyEnvelope(s); f.store.values.set(key, old); f.store.failWrite = true;
    const next = f.restart();
    await expect(next.get(s.sessionID)).rejects.toMatchObject({ code: "storage" });
    expect(await f.store.get(key)).toEqual(old);
    expect(() => next.get(s.sessionID)).toThrow();
  });

  test("legacy marker composes with a manual diagnostic and cannot discard an existing non-budget safety hold", async () => {
    for (const safetyPause of [null, { reason: "ambiguous" as const, detail: "Native delivery still requires reconciliation" }]) {
      const f = fixture(); let s = await f.service.create(input, agent); s = await f.service.pause(target(s), agent);
      const old = { ...legacyEnvelope(s), safetyPause, budgetResumeRequired: true };
      f.store.values.set(key, old);
      const service = f.restart(); s = (await service.get(s.sessionID))!;
      expect(s.explicitStop).toBe(true);
      expect(s.current!.reason).toBe("manual");
      expect(s.safetyPause!.reason).toBe(safetyPause?.reason ?? "budget");
      await expect(service.resume({ ...target(s), tokens: zero }, { ...agent, trustedRecovery: true })).rejects.toMatchObject({ code: "recovery_required" });
      const resumed = await service.resume({ ...target(s), tokens: zero }, recovered);
      expect(resumed.current!.status).toBe("active"); expect(resumed.safetyPause).toBeNull();
    }
  });

  test("cancellation and replacement cannot release a migrated session-level legacy hold", async () => {
    const f = fixture(); let s = await f.service.create(input, agent);
    s = await f.service.pauseForSafety(s.sessionID, "runtime_failure", "Diagnostic replaced a historical budget hold");
    f.store.values.set(key, { ...legacyEnvelope(s), budgetResumeRequired: true });
    const service = f.restart(); s = (await service.get(s.sessionID))!;
    s = await service.cancel(target(s), agent);
    s = await service.create({ ...input, objective: "Replacement remains within authorized scope" }, agent);
    expect(s.current).toMatchObject({ status: "paused", reason: "runtime_failure", limits: null });
    expect(s.explicitStop).toBe(true);
    await expect(service.resume({ ...target(s), tokens: zero }, { ...agent, trustedRecovery: true })).rejects.toMatchObject({ code: "recovery_required" });
    expect((await service.resume({ ...target(s), tokens: zero }, recovered)).current!.status).toBe("active");
  });
});
