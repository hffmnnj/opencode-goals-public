import type { StorageDomain } from "@opencode/plugin/promise/storage";
import { createHash } from "node:crypto";
import { z } from "zod";
import { GoalError } from "./errors.ts";
import {
  ActorSchema, BlockSchema, CancelSchema, CheckpointInputSchema, CompleteSchema,
  ConfigSchema, CreateSchema,
  StoredEnvelopeSchema, IdSchema, PauseSchema, RecordEvidenceSchema, ReserveSchema,
  ResumeSchema, ReviseSchema, SetPlanSchema, StartSchema, TokensSchema, sessionStorageKey,
  type Actor, type CreateInput, type Dispatch, type Goal, type GoalConfigInput,
  type PauseReason, type ReserveInput, type SessionEnvelope, type Tokens, type Usage,
} from "./schema.ts";

export type GoalStorage = Pick<StorageDomain, "get" | "set">;
/** Adapter-owned policy, never populated from untrusted tool/RPC arguments. */
export interface GoalAccess {
  actor: Actor;
  executionAllowed: boolean;
  trustedRecovery?: boolean;
  explicitResume?: boolean;
}
export interface GoalServiceOptions {
  storage: GoalStorage;
  /** Canonical location identity and externally established exclusive runtime owner. */
  location: string;
  /** Stable server namespace shared with the owner lock; omitted only for the legacy server. */
  namespace?: string;
  owner: string;
  config?: GoalConfigInput;
  now?: () => number;
  uuid?: () => string;
}
export type ReservationResult =
  | { kind: "reserved"; state: SessionEnvelope; dispatch: Dispatch }
  | { kind: "skipped"; reason: "inactive" | "disabled" | "stale_generation" | "stale_idle" | "pending"; state: SessionEnvelope }
  | { kind: "paused"; reason: PauseReason; state: SessionEnvelope; withdrawPromptId?: string };
export interface SettlementResult {
  state: SessionEnvelope;
  /** Admission raced a lifecycle change: withdraw only this plugin-owned ID. */
  withdraw: boolean;
}

const SYSTEM: Actor = { kind: "system", id: "goals" };
const emptyUsage = (): Usage => ({ autoTurns: 0, activeSeconds: 0, tokens: 0 });
const closed = (goal: Goal) => goal.status === "complete" || goal.status === "cancelled";
const safeResumeReasons: PauseReason[] = ["manual", "blocked", "restricted"];

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new GoalError("validation", "Invalid goal operation input", { cause: result.error });
  return result.data;
}
function unique(items: readonly { id: string }[]): void {
  if (new Set(items.map(item => item.id)).size !== items.length)
    throw new GoalError("validation", "IDs must be unique within their collection");
}
function tokenTotalDelta(before: Tokens, after: Tokens): number {
  return Math.max(0, after.input - before.input) + Math.max(0, after.output - before.output)
    + Math.max(0, after.reasoning - before.reasoning)
    + Math.max(0, after.cache.read - before.cache.read) + Math.max(0, after.cache.write - before.cache.write);
}
function tokenHighWater(before: Tokens, after: Tokens): Tokens {
  return {
    input: Math.max(before.input, after.input), output: Math.max(before.output, after.output),
    reasoning: Math.max(before.reasoning, after.reasoning),
    cache: { read: Math.max(before.cache.read, after.cache.read), write: Math.max(before.cache.write, after.cache.write) },
  };
}

/**
 * Durable, adapter-neutral state machine. Serializes only within this service instance.
 * The runtime MUST establish exclusive ownership, reconcile inbox/permissions/forms,
 * and recheck ownership before admission. This is not a storage CAS or an admission lock.
 * Operational access lazily performs fail-closed restart recovery.
 */
export class GoalService {
  private readonly storage: GoalStorage;
  readonly location: string;
  readonly namespace?: string;
  readonly owner: string;
  readonly config: Readonly<ReturnType<typeof ConfigSchema.parse>>;
  private readonly clock: () => number;
  private readonly uuid: () => string;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly recovered = new Set<string>();
  private disposed = false;
  private storageFaulted = false;

  constructor(options: GoalServiceOptions) {
    this.storage = options.storage;
    this.location = parse(z.string().trim().min(1).max(4096), options.location);
    this.namespace = options.namespace === undefined ? undefined : parse(z.string().trim().min(1).max(512), options.namespace);
    this.owner = parse(IdSchema, options.owner);
    this.config = Object.freeze(parse(ConfigSchema, options.config ?? {}));
    this.clock = options.now ?? Date.now;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  private now(): number {
    return parse(z.number().finite().nonnegative(), this.clock());
  }
  private alive(): void {
    if (this.disposed) throw new GoalError("disposed", "Goal service is disposed");
    if (this.storageFaulted) throw new GoalError("storage", "Storage failed; a new runtime must recover before scheduling");
  }
  private access(access: GoalAccess): GoalAccess {
    return parse(z.object({ actor: ActorSchema, executionAllowed: z.boolean(), trustedRecovery: z.boolean().optional(), explicitResume: z.boolean().optional() }).strict(), access);
  }
  private serial<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
    this.alive();
    parse(IdSchema, sessionID);
    const prior = this.queues.get(sessionID) ?? Promise.resolve();
    const result = prior.then(async () => { this.alive(); return run(); });
    const tail = result.then(() => {}, () => {});
    this.queues.set(sessionID, tail);
    void tail.then(() => { if (this.queues.get(sessionID) === tail) this.queues.delete(sessionID); });
    return result;
  }

  /** No write begins after this call. Resolves after already-started writes settle. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.queues.values()]);
  }

  private empty(sessionID: string): SessionEnvelope {
    return {
      schemaVersion: 2, location: this.location, sessionID, owner: this.owner, revision: 0,
      current: null, archives: [], history: [],
      allowance: { limits: null, usage: emptyUsage() },
      highWater: null, activeSince: null, lastIdle: null, dispatch: null, safetyPause: null, explicitStop: false,
    };
  }
  private validateStored(value: unknown, sessionID: string): SessionEnvelope {
    const result = StoredEnvelopeSchema.safeParse(value);
    if (!result.success) throw new GoalError("corrupt_state", "Stored goal schema is unknown or corrupt", { cause: result.error });
    const state = result.data;
    try {
      if (state.location !== this.location || state.sessionID !== sessionID) throw new Error("Identity mismatch");
      unique([...state.archives, ...(state.current ? [state.current] : [])]);
      for (const goal of [...state.archives, ...(state.current ? [state.current] : [])]) {
        unique(goal.criteria); unique(goal.plan); unique(goal.checkpoints);
        if (goal.status === "active" && (goal.reason !== null || goal.detail !== null)) throw new Error("Active reason");
        if ((goal.status === "paused" || goal.status === "blocked") && (!goal.reason || !goal.detail)) throw new Error("Missing pause reason");
        if (goal.status === "blocked" && goal.reason !== "blocked") throw new Error("Missing blocker");
        if (goal.status === "complete" && (goal.criteria.some(c => !c.evidence.length) || goal.plan.some(s => s.required && s.status !== "completed"))) throw new Error("Invalid completion");
      }
      if ((state.current?.status === "active") !== (state.activeSince !== null)) throw new Error("Invalid time baseline");
      if (state.archives.some(goal => !closed(goal))) throw new Error("Open archive");
      if (state.safetyPause && safeResumeReasons.includes(state.safetyPause.reason)) throw new Error("Invalid system hold");
      if (state.safetyPause && state.current?.status === "active") throw new Error("Active system hold");
      if (state.current && !state.highWater) throw new Error("Missing usage high-water mark");
      if (state.dispatch && ![...state.archives, ...(state.current ? [state.current] : [])].some(g => g.id === state.dispatch!.goalId)) throw new Error("Unknown dispatch owner");
    } catch (cause) {
      throw new GoalError("corrupt_state", "Stored goal invariants are corrupt", { cause });
    }
    return state;
  }
  private async load(sessionID: string): Promise<SessionEnvelope | null> {
    let raw: unknown;
    try { raw = await this.storage.get(sessionStorageKey(this.location, sessionID, this.namespace)); }
    catch (cause) { this.storageFaulted = true; throw new GoalError("storage", "Cannot read goal state", { cause }); }
    this.alive();
    if (raw === undefined) return null;
    const state = this.validateStored(raw, sessionID);
    let needsMigration = (raw as { schemaVersion?: unknown }).schemaVersion === 1;
    if (state.explicitStop === undefined) {
      // Old reloads could overwrite manual/blocked with restart. Audit intent is
      // stronger than that rewrite; an absent/truncated audit never proves consent.
      const intent = state.history.findLast(item => ["pause", "block", "cancel", "resume", "create"].includes(item.action));
      state.explicitStop = !!state.current && (closed(state.current) || ["manual", "blocked"].includes(state.current.reason ?? "")
        || !!intent && ["pause", "block", "cancel"].includes(intent.action)
        || state.current.reason === "restart" && !intent);
    }
    if (!this.recovered.has(sessionID)) {
      // Deliberately do NOT charge time since the previous runtime's last durable observation.
      const needsRecovery = state.current?.status === "active" || state.dispatch !== null;
      if (needsRecovery) {
        if (!state.explicitStop && state.current?.status === "active")
          state.safetyPause = { reason: "restart", detail: "Recovered runtime state; trusted reconciliation is required" };
        if (state.current && closed(state.current) && state.dispatch && !state.safetyPause)
          state.safetyPause = { reason: "restart", detail: "Closed goal has an outstanding dispatch requiring reconciliation" };
        if (state.current && !closed(state.current) && !state.explicitStop && state.current.status === "active")
          this.stop(state, "restart", "Recovered runtime state; trusted recovery is required", this.now());
        if (state.dispatch) state.dispatch.phase = "ambiguous";
        state.activeSince = null;
        state.owner = this.owner;
        await this.save(state, SYSTEM, "recover", "Recovered without replaying dispatch", !!state.current && !closed(state.current));
        needsMigration = false;
      }
      this.recovered.add(sessionID);
    }
    if (needsMigration) {
      // Representation-only migration preserves audit retention, revisions and all
      // accounting. Restart reconciliation above remains a separate lifecycle write.
      try { await this.storage.set(sessionStorageKey(this.location, sessionID, this.namespace), JSON.parse(JSON.stringify(state))); }
      catch (cause) { this.storageFaulted = true; throw new GoalError("storage", "Cannot migrate goal state; scheduling must stop", { cause }); }
      this.alive();
    }
    return state;
  }
  private async save(state: SessionEnvelope, actor: Actor, action: string, reason: string, contentChange = true, audit = true): Promise<void> {
    this.alive();
    state.owner = this.owner;
    state.revision++;
    if (state.current) {
      if (contentChange) state.current.revision++;
      // Routine accounting persistence carries no lifecycle meaning: it must neither
      // append audit entries (which would evict real history under repeated reads)
      // nor move the goal timestamp.
      if (audit) {
        state.current.updatedAt = this.now();
        state.history.push({ goalId: state.current.id, action, reason, actor, time: this.now(), revision: state.current.revision });
      }
    }
    state.history = state.history.slice(-this.config.maxHistory);
    const validated = this.validateStored(state, state.sessionID);
    try {
      // Optional undefined properties must not reach the plugin's durable JSON storage.
      await this.storage.set(sessionStorageKey(this.location, state.sessionID, this.namespace), JSON.parse(JSON.stringify(validated)));
    } catch (cause) { this.storageFaulted = true; throw new GoalError("storage", "Cannot persist goal state; scheduling must stop", { cause }); }
    this.alive();
    this.recovered.add(state.sessionID);
  }
  private async required(sessionID: string): Promise<SessionEnvelope> {
    const state = await this.load(sessionID);
    if (!state?.current) throw new GoalError("no_goal", "No attached goal");
    return state;
  }
  private target(state: SessionEnvelope, goalId: string, expectedRevision?: number): Goal {
    if (!state.current) throw new GoalError("no_goal", "No attached goal");
    if (state.current.id !== goalId) throw new GoalError("wrong_goal", "Attached goal identity has changed");
    if (expectedRevision !== undefined && state.current.revision !== expectedRevision)
      throw new GoalError("stale_revision", "Goal revision has changed; inspect before retrying");
    return state.current;
  }
  private open(goal: Goal): void {
    if (closed(goal)) throw new GoalError("closed_goal", "Goal is closed");
  }
  private account(state: SessionEnvelope, tokens?: Tokens): void {
    const now = this.now();
    if (state.activeSince !== null && state.current?.status === "active") {
      const seconds = Math.max(0, now - state.activeSince) / 1000;
      state.current.usage.activeSeconds += seconds;
      state.allowance.usage.activeSeconds += seconds;
      state.activeSince = Math.max(state.activeSince, now);
    }
    if (tokens) {
      if (state.highWater) {
        const delta = tokenTotalDelta(state.highWater, tokens);
        // Tokens are cumulative session work, not exact plugin attribution. Include
        // paused open-goal work so pause/resume cannot erase not-yet-observed usage.
        state.allowance.usage.tokens += delta;
        if (state.current && !closed(state.current)) state.current.usage.tokens += delta;
        state.highWater = tokenHighWater(state.highWater, tokens);
      } else state.highWater = structuredClone(tokens);
    }
  }
  private stop(state: SessionEnvelope, reason: PauseReason, detail: string, now: number): void {
    const goal = state.current!;
    goal.status = reason === "blocked" ? "blocked" : "paused";
    goal.reason = reason; goal.detail = detail; goal.generation++;
    goal.eligibleIdleAfter = now;
    state.activeSince = null;
    if (reason === "budget") state.explicitStop = true;
    if (!safeResumeReasons.includes(reason)) state.safetyPause = { reason, detail };
    if (state.dispatch) state.dispatch.phase = "invalidated";
  }

  /** Read snapshot with projected active elapsed time; projection does not change revision. */
  get(sessionID: string): Promise<SessionEnvelope | null> {
    return this.serial(sessionID, async () => {
      const state = await this.load(sessionID);
      if (state) this.account(state);
      return state;
    });
  }

  /** Eager equivalent of lazy first-read recovery. Never replays an intent. */
  recoverSession(sessionID: string): Promise<SessionEnvelope | null> { return this.get(sessionID); }

  create(input: CreateInput, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(CreateSchema, input); const policy = this.access(access);
    unique(data.criteria); unique(data.plan);
    return this.serial(data.sessionID, async () => {
      const state = await this.load(data.sessionID) ?? this.empty(data.sessionID);
      if (state.current && !closed(state.current)) throw new GoalError("conflict", "An open goal is already attached");
      if (state.dispatch) throw new GoalError("dispatch_pending", "Reconcile the previous goal's dispatch before replacing it");
      this.account(state, data.tokens);
      if (state.current) state.archives = [...state.archives, state.current].slice(-this.config.maxArchives);
      const now = this.now();
      state.current = {
        id: `goal_${this.uuid()}`, revision: 0, generation: 1, objective: data.objective,
        criteria: data.criteria.map(c => ({ ...c, evidence: [] })), plan: data.plan,
        checkpoints: [], status: "active", reason: null, detail: null, limits: null, usage: emptyUsage(),
        createdAt: now, updatedAt: now, eligibleIdleAfter: now,
        progress: 0, dispatchProgress: 0, noProgress: 0, checkpointEvidence: [],
      };
      // Replacement does not authorize releasing a session-level legacy hold.
      state.explicitStop = !!state.explicitStop && !!state.safetyPause;
      state.activeSince = now;
      if (state.safetyPause) this.stop(state, state.safetyPause.reason, state.safetyPause.detail, now);
      else if (!policy.executionAllowed) this.stop(state, "restricted", "Execution is not allowed by the current agent policy", now);
      await this.save(state, policy.actor, "create", "Goal created without changing underlying work permissions");
      return state;
    });
  }

  private edit<T extends { sessionID: string; goalId: string; expectedRevision: number }>(
    data: T, access: GoalAccess, action: string, reason: string, change: (goal: Goal, state: SessionEnvelope, policy: GoalAccess) => void,
  ): Promise<SessionEnvelope> {
    const policy = this.access(access);
    return this.serial(data.sessionID, async () => {
      const state = await this.required(data.sessionID);
      const goal = this.target(state, data.goalId, data.expectedRevision); this.open(goal);
      this.account(state);
      change(goal, state, policy);
      await this.save(state, policy.actor, action, reason);
      return state;
    });
  }

  revise(input: z.input<typeof ReviseSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(ReviseSchema, input);
    return this.edit(data, access, "revise", data.reason, goal => {
      if (data.objective !== undefined && data.objective !== goal.objective) {
        if (goal.criteria.some(c => c.evidence.length) || goal.plan.some(s => s.status === "completed"))
          throw new GoalError("plan_preservation", "Cannot change objective after verified work; create a new goal instead");
        goal.objective = data.objective;
      }
      if (data.criteria) {
        unique(data.criteria);
        for (const old of goal.criteria.filter(c => c.evidence.length)) {
          const next = data.criteria.find(c => c.id === old.id);
          if (!next || next.description !== old.description)
            throw new GoalError("plan_preservation", "Verified acceptance criteria cannot be removed or rewritten");
        }
        goal.criteria = data.criteria.map(c => ({ ...c, evidence: goal.criteria.find(old => old.id === c.id)?.evidence ?? [] }));
      }
    });
  }

  setPlan(input: z.input<typeof SetPlanSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(SetPlanSchema, input); unique(data.steps);
    return this.edit(data, access, "plan", data.reason, goal => {
      if (data.mode === "append") {
        if (data.steps.length === 0)
          throw new GoalError("validation", "Append requires at least one new plan step");
        const existing = new Set(goal.plan.map(step => step.id));
        if (data.steps.some(step => existing.has(step.id)))
          throw new GoalError("validation", "Plan step IDs must not duplicate existing steps");
        if (goal.plan.length + data.steps.length > 64)
          throw new GoalError("validation", "Combined plan exceeds 64 steps");
        if (data.steps.some(step => step.status === "completed")) goal.progress++;
        goal.plan = [...goal.plan, ...data.steps];
        return;
      }
      for (const old of goal.plan) {
        const next = data.steps.find(step => step.id === old.id);
        if (old.status === "completed" && (!next || next.status !== "completed" || next.description !== old.description || next.required !== old.required || next.evidence !== old.evidence))
          throw new GoalError("plan_preservation", "Completed steps and their evidence cannot be removed, weakened or reopened");
        if (old.evidence && (!next || next.evidence !== old.evidence))
          throw new GoalError("plan_preservation", "Recorded plan evidence cannot be discarded");
      }
      if (data.steps.some(step => step.status === "completed" && goal.plan.find(old => old.id === step.id)?.status !== "completed")) goal.progress++;
      goal.plan = data.steps;
    });
  }

  recordEvidence(input: z.input<typeof RecordEvidenceSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(RecordEvidenceSchema, input);
    return this.edit(data, access, "evidence", "Recorded reported acceptance evidence", (goal, _state, policy) => {
      const criterion = goal.criteria.find(c => c.id === data.criterionId);
      if (!criterion) throw new GoalError("validation", "Unknown acceptance criterion");
      if (criterion.evidence.some(e => e.summary === data.evidence.summary && e.reference === data.evidence.reference)) return;
      if (criterion.evidence.length >= 10) throw new GoalError("validation", "Acceptance evidence capacity reached");
      criterion.evidence.push({ ...data.evidence, recordedAt: this.now(), reportedBy: policy.actor });
      goal.progress++;
    });
  }

  checkpoint(input: z.input<typeof CheckpointInputSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(CheckpointInputSchema, input);
    return this.edit(data, access, "checkpoint", data.summary, (goal, _state, policy) => {
      if (data.evidence) {
        const fingerprint = createHash("sha256").update(data.evidence).digest("hex");
        if (!goal.checkpointEvidence.includes(fingerprint)) {
          if (goal.checkpointEvidence.length >= 128) throw new GoalError("validation", "Durable checkpoint evidence capacity reached; use acceptance or plan verification milestones");
          goal.checkpointEvidence.push(fingerprint);
          goal.progress++;
        }
      }
      goal.checkpoints.push({ id: `checkpoint_${this.uuid()}`, summary: data.summary, evidence: data.evidence, nextStep: data.nextStep, actor: policy.actor, time: this.now() });
      goal.checkpoints = goal.checkpoints.slice(-this.config.maxCheckpoints);
    });
  }

  complete(input: z.input<typeof CompleteSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(CompleteSchema, input);
    return this.edit(data, access, "complete", data.summary, (goal, state) => {
      if (goal.criteria.some(c => !c.evidence.length) || goal.plan.some(s => s.required && s.status !== "completed"))
        throw new GoalError("evidence_required", "All acceptance criteria need evidence and all required steps must be completed");
      goal.status = "complete"; goal.reason = null; goal.detail = data.summary; goal.generation++;
      state.activeSince = null;
      if (state.dispatch) state.dispatch.phase = "invalidated";
    });
  }

  block(input: z.input<typeof BlockSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(BlockSchema, input);
    return this.edit(data, access, "block", data.blocker, (_goal, state) => {
      // Preserve the session recovery gate, but honor a new explicit blocker.
      // Resuming this blocked goal still requires reconciliation of that gate.
      this.stop(state, "blocked", data.blocker, this.now());
      state.explicitStop = true;
    });
  }

  pause(input: z.input<typeof PauseSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(PauseSchema, input);
    return this.safety(data, access, "pause", data.reason);
  }
  cancel(input: z.input<typeof CancelSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(CancelSchema, input);
    return this.safety(data, access, "cancel", data.reason);
  }
  private safety(data: { sessionID: string; goalId: string }, access: GoalAccess, action: "pause" | "cancel", reason: string): Promise<SessionEnvelope> {
    const policy = this.access(access);
    return this.serial(data.sessionID, async () => {
      const state = await this.required(data.sessionID);
      const goal = this.target(state, data.goalId);
      if (closed(goal)) return state;
      if (action === "pause" && (goal.status === "paused" || goal.status === "blocked")) {
        if (!state.explicitStop) {
          state.explicitStop = true;
          goal.generation++;
          await this.save(state, policy.actor, "pause", reason);
        }
        return state;
      }
      this.account(state);
      state.explicitStop = true;
      if (action === "pause") this.stop(state, "manual", reason, this.now());
      else {
        goal.status = "cancelled"; goal.reason = null; goal.detail = reason; goal.generation++;
        state.activeSince = null;
        if (state.dispatch) state.dispatch.phase = "invalidated";
      }
      await this.save(state, policy.actor, action, reason);
      return state;
    });
  }

  resume(input: z.input<typeof ResumeSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(ResumeSchema, input); const policy = this.access(access);
    return this.serial(data.sessionID, async () => {
      const state = await this.required(data.sessionID);
      const goal = this.target(state, data.goalId, data.expectedRevision); this.open(goal);
      if (!policy.executionAllowed) throw new GoalError("execution_restricted", "Execution is not allowed by current policy");
      if (goal.status === "active") throw new GoalError("invalid_transition", "Goal is already active");
      if (state.explicitStop && (state.safetyPause || !safeResumeReasons.includes(goal.reason!)) && !(policy.trustedRecovery && policy.explicitResume))
        throw new GoalError("recovery_required", "A separate explicit reconciled resume is required for this stop");
      if ((state.safetyPause || goal.reason && !safeResumeReasons.includes(goal.reason)) && !policy.trustedRecovery)
        throw new GoalError("recovery_required", "Trusted runtime reconciliation is required for this pause");
      if ((goal.reason === "no_progress" || state.safetyPause?.reason === "no_progress" || goal.noProgress >= this.config.maxNoProgress)
        && goal.progress <= goal.dispatchProgress)
        throw new GoalError("recovery_required", "New substantive verification progress is required before recovery");
      this.account(state, data.tokens);
      if (state.dispatch) {
        await this.save(state, SYSTEM, "resume_denied", "Persisted observed usage; dispatch reconciliation required", false);
        throw new GoalError("dispatch_pending", "Outstanding dispatch must be reconciled before resuming");
      }
      state.safetyPause = null;
      state.explicitStop = false;
      // Carry genuinely new progress across a recovery start's dispatch baseline.
      // Never reset a stagnant window merely because recovery was requested.
      if (goal.progress > goal.dispatchProgress) goal.noProgress = 0;
      goal.status = "active"; goal.reason = null; goal.detail = null; goal.generation++;
      goal.eligibleIdleAfter = this.now(); state.activeSince = this.now();
      // Resume does not replenish ANY counters, including the no-progress window.
      // Only new reported verification progress can clear that window at dispatch.
      await this.save(state, policy.actor, "resume", "Goal explicitly resumed");
      return state;
    });
  }

  /** Persist cumulative observations. High-water marks never decrease or double charge. */
  observeUsage(sessionID: string, tokens: z.input<typeof TokensSchema>): Promise<SessionEnvelope> {
    const observed = parse(TokensSchema, tokens);
    return this.serial(sessionID, async () => {
      const state = await this.required(sessionID);
      this.account(state, observed);
      // Routine accounting must not evict lifecycle history or change content revision.
      await this.save(state, SYSTEM, "usage", "Reconciled cumulative session usage", false, false);
      return state;
    });
  }

  /** Runtime-only system pause. Agent adapters must not expose arbitrary reason selection. */
  pauseForSafety(sessionID: string, reason: Exclude<PauseReason, "manual" | "blocked" | "budget">, detail: string, expected?: { goalId: string; generation: number }): Promise<SessionEnvelope> {
    const checked = parse(z.object({ reason: z.enum(["restricted", "restart", "ambiguous", "interrupted", "failed", "no_progress", "runtime_failure"]), detail: z.string().trim().min(1).max(4000) }), { reason, detail });
    return this.serial(sessionID, async () => {
      const state = await this.required(sessionID);
      if (expected && (state.current!.id !== expected.goalId || state.current!.generation !== expected.generation)) return state;
      if (closed(state.current!)) return state;
      if (state.explicitStop || ["manual", "blocked"].includes(state.current!.reason ?? "")) return state;
      this.account(state);
      // Do not turn restart/ambiguity into an agent-resumable restricted pause.
      const currentReason = state.current!.reason;
      if (currentReason && !safeResumeReasons.includes(currentReason) && safeResumeReasons.includes(checked.reason)) return state;
      this.stop(state, checked.reason, checked.detail, this.now());
      await this.save(state, SYSTEM, "safety_pause", checked.detail);
      return state;
    });
  }

  /**
   * Reserve BEFORE admission. Runtime checks (idle, inbox, permissions, forms, owner)
   * must already have succeeded and must be rechecked before using this intent.
   * A reservation remains charged even if admission fails or is ambiguous.
   */
  reserveDispatch(input: ReserveInput, access: GoalAccess): Promise<ReservationResult> {
    const data = parse(ReserveSchema, input); const policy = this.access(access);
    return this.serial(data.sessionID, async () => {
      const state = await this.required(data.sessionID);
      const goal = this.target(state, data.goalId);
      const skip = (reason: Extract<ReservationResult, { kind: "skipped" }>["reason"]): ReservationResult => ({ kind: "skipped", reason, state });
      if (goal.generation !== data.generation) return skip("stale_generation");
      if (goal.status !== "active") return skip("inactive");
      if (data.idle.time <= goal.eligibleIdleAfter || data.idle.time > this.now()
        || state.lastIdle && (state.lastIdle.id === data.idle.id || data.idle.time <= state.lastIdle.time)) return skip("stale_idle");
      if (state.dispatch && (state.dispatch.phase !== "admitted" || data.idle.time <= state.dispatch.createdAt)) return skip("pending");
      this.account(state, data.tokens);
      state.lastIdle = data.idle;
      // Runtime must ensure an admitted item was delivered before forwarding this idle.
      if (state.dispatch?.phase === "admitted") state.dispatch = null;
      let reason: PauseReason | undefined;
      if (data.idle.outcome !== "succeeded") reason = data.idle.outcome;
      else if (!policy.executionAllowed) reason = "restricted";
      if (!reason && this.config.autoContinue) {
        if (goal.usage.autoTurns > 0) goal.noProgress = goal.progress > goal.dispatchProgress ? 0 : goal.noProgress + 1;
        if (goal.noProgress >= this.config.maxNoProgress) reason = "no_progress";
      }
      if (reason) {
        const withdrawPromptId = state.dispatch?.id;
        this.stop(state, reason, `Continuation paused: ${reason}`, this.now());
        await this.save(state, SYSTEM, "continuation_pause", `Continuation paused: ${reason}`);
        return { kind: "paused", reason, state, withdrawPromptId };
      }
      if (!this.config.autoContinue) {
        await this.save(state, SYSTEM, "idle", "Automatic continuation is disabled", false);
        return skip("disabled");
      }
      goal.usage.autoTurns++; state.allowance.usage.autoTurns++;
      goal.dispatchProgress = goal.progress;
      const dispatch: Dispatch = {
        id: `msg_${this.uuid()}`, goalId: goal.id, generation: goal.generation,
        idleId: data.idle.id, createdAt: this.now(), phase: "reserved",
      };
      state.dispatch = dispatch;
      await this.save(state, SYSTEM, "dispatch_reserve", "Reserved and charged continuation before admission", false);
      return { kind: "reserved", state, dispatch };
    });
  }

  /** Successful admission acknowledgment; NEVER authorizes a second admission. */
  acknowledgeDispatch(sessionID: string, dispatchId: string): Promise<SettlementResult> {
    parse(IdSchema, dispatchId);
    return this.serial(sessionID, async () => {
      const state = await this.required(sessionID);
      const dispatch = state.dispatch;
      if (!dispatch || dispatch.id !== dispatchId) throw new GoalError("conflict", "Dispatch identity has changed");
      const goal = state.current!;
      const withdraw = dispatch.phase === "invalidated" || dispatch.phase === "ambiguous"
        || goal.id !== dispatch.goalId || goal.generation !== dispatch.generation || goal.status !== "active";
      dispatch.phase = withdraw ? "invalidated" : "admitted";
      await this.save(state, SYSTEM, "dispatch_ack", withdraw ? "Admission raced a lifecycle change; withdraw owned input" : "Owned input admitted", false);
      return { state, withdraw };
    });
  }

  /** Ambiguous/error admission pauses without refund. Retains the ID for reconciliation. */
  abandonDispatch(sessionID: string, dispatchId: string, detail: string): Promise<SessionEnvelope> {
    parse(IdSchema, dispatchId); parse(z.string().trim().min(1).max(4000), detail);
    return this.serial(sessionID, async () => {
      const state = await this.required(sessionID);
      if (state.dispatch?.id !== dispatchId) throw new GoalError("conflict", "Dispatch identity has changed");
      this.account(state);
      state.safetyPause = { reason: "ambiguous", detail };
      if (!state.explicitStop && !closed(state.current!)) {
        this.stop(state, "ambiguous", detail, this.now());
      }
      state.dispatch.phase = "ambiguous";
      await this.save(state, SYSTEM, "dispatch_abandon", detail, !closed(state.current!));
      return state;
    });
  }

  /**
   * Runtime-only confirmation that an owned intent is reconciled/withdrawn. On uncertain
   * delivery the runtime must first pause/abandon; never use this as an automatic retry.
   */
  retireDispatch(sessionID: string, dispatchId: string): Promise<SessionEnvelope> {
    parse(IdSchema, dispatchId);
    return this.serial(sessionID, async () => {
      const state = await this.required(sessionID);
      if (state.dispatch?.id !== dispatchId) throw new GoalError("conflict", "Dispatch identity has changed");
      if (state.current!.status === "active" && state.dispatch.phase !== "invalidated") throw new GoalError("invalid_transition", "Pause before retiring a dispatch");
      state.dispatch = null;
      await this.save(state, SYSTEM, "dispatch_retire", "Runtime reconciled plugin-owned input without refund", false);
      return state;
    });
  }

  /** User input supersedes automation, not the goal's authorization or stop intent. */
  yieldInput(sessionID: string): Promise<SessionEnvelope> {
    return this.serial(sessionID, async () => {
      const state = await this.required(sessionID);
      if (state.current!.status !== "active" || !state.dispatch) return state;
      this.account(state);
      state.current!.generation++;
      state.dispatch.phase = "invalidated";
      await this.save(state, SYSTEM, "yield", "New session input superseded owned automation");
      return state;
    });
  }

  /** Runtime-only deliberate command start. Charged without a resource ceiling. */
  reserveStart(input: z.input<typeof StartSchema>, access: GoalAccess): Promise<SessionEnvelope> {
    const data = parse(StartSchema, input); const policy = this.access(access);
    return this.serial(data.sessionID, async () => {
      const state = await this.required(data.sessionID); const goal = this.target(state, data.goalId);
      if (goal.generation !== data.generation || goal.status !== "active") throw new GoalError("invalid_transition", "Start lifecycle has changed");
      if (!policy.executionAllowed) throw new GoalError("execution_restricted", "Execution is restricted");
      if (state.dispatch) throw new GoalError("dispatch_pending", "Reconcile outstanding input first");
      this.account(state, data.tokens);
      goal.usage.autoTurns++; state.allowance.usage.autoTurns++;
      goal.dispatchProgress = goal.progress;
      state.dispatch = { id: `msg_${this.uuid()}`, goalId: goal.id, generation: goal.generation, idleId: `start_${this.uuid()}`, createdAt: this.now(), phase: "reserved" };
      await this.save(state, policy.actor, "start_reserve", "Charged explicit command start (not an automatic idle continuation)", false);
      return state;
    });
  }
}
