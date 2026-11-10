import { z } from "zod";
import { BridgeError, type ServerBridge, type BridgeSnapshot, type BackgroundSnapshot } from "./bridge.ts";
import { DiagnosticsSchema, FullGoalSchema, POLICY, PublicResultSchema, ToolSchemas, type Operation, type PublicResult } from "./contracts.ts";
import { GoalError } from "./errors.ts";
import { executionPolicy, type Admission, type NativeHost, type NativeSession } from "./native.ts";
import type { RuntimeOwner } from "./ownership.ts";
import { coreOptions, RuntimeOptionsSchema, type RuntimeOptions, type RuntimeOptionsInput } from "./options.ts";
import { GoalService, type GoalAccess, type GoalStorage } from "./service.ts";
import { renderGoalContext, type Dispatch, type SessionEnvelope } from "./schema.ts";

export interface Invocation { kind: "agent" | "human"; agent?: string; signal?: AbortSignal; commandStart?: boolean }
export interface StartResult { kind: "admitted" | "withdrawal_requested"; admissionId: string; state: SessionEnvelope }
type Fence = { goalId: string; generation: number };
type DeliveryWait = { waitingDispatch?: string; deliveryRecheck?: boolean };
type Withdrawal = { id: string; goalId: string; confirmed: boolean; requested: boolean; pending?: Promise<void> };
type Run = DeliveryWait & {
  started: number; fence?: Fence; success?: number; controller: AbortController;
  background?: BackgroundSnapshot; checking?: boolean; completions?: Set<string>;
};
const backgroundKeys = (snapshot: BackgroundSnapshot) => [...snapshot.shells.map(id => `shell:${id}`), ...snapshot.children.map(id => `child:${id}`)];
const backgroundBusy = (snapshot: BackgroundSnapshot) => snapshot.shells.length > 0 || snapshot.children.length > 0;
type Intent = Fence & { id: string; epoch: number; source?: Run };
type Recovery = Fence & DeliveryWait & {
  epoch: number; explicit: boolean; commandStart: boolean; ready: boolean; checking: boolean; waiting: boolean;
  boundary: boolean; controller: AbortController; authorizationId?: string; background?: BackgroundSnapshot; completions?: Set<string>;
};
const EVENT = z.object({
  type: z.string(), created: z.number().finite(),
  location: z.object({ directory: z.string(), workspaceID: z.string().optional() }).optional(),
  data: z.object({ sessionID: z.string().startsWith("ses") }).passthrough(),
});
const TAG = "opencode-goals";
const terminal = (state: SessionEnvelope | null) => !state?.current || ["complete", "cancelled"].includes(state.current.status);
const fenceOf = (state: SessionEnvelope): Fence => ({ goalId: state.current!.id, generation: state.current!.generation });
const sameFence = (state: SessionEnvelope | null, fence: Fence) => !!state?.current && state.current.id === fence.goalId && state.current.generation === fence.generation;

export interface GoalRuntimeOptions {
  host: NativeHost; storage: GoalStorage; owner: RuntimeOwner; bridge: ServerBridge;
  options?: RuntimeOptionsInput; now?: () => number; uuid?: () => string; namespace?: string;
}

/** Native bookkeeping + fail-closed scheduler. No permission escalation or host interruption. */
export class GoalRuntime {
  readonly options: RuntimeOptions;
  private readonly host: NativeHost;
  private readonly owner: RuntimeOwner;
  private readonly bridge: ServerBridge;
  private readonly service: GoalService;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly born: number;
  private dead = false;
  private observation: "observing" | "failed" | "disabled" = "disabled";
  private bridgeState: "unchecked" | "verified" | "unavailable" = "unchecked";
  private diagnosticReason?: string;
  private readonly known = new Set<string>();
  private readonly lastAgent = new Map<string, string>();
  private readonly lastFence = new Map<string, Fence>();
  private readonly publishedRevision = new Map<string, number>();
  private readonly runs = new Map<string, Run>();
  private readonly recoveries = new Map<string, Recovery>();
  private readonly userTurns = new Map<string, string>();
  private readonly lastStarted = new Map<string, number>();
  private readonly epochs = new Map<string, number>();
  private readonly moved = new Set<string>();
  private readonly admitting = new Map<string, Intent>();
  private readonly withdrawals = new Map<string, Withdrawal>();
  private readonly admissions = new Set<Promise<void>>();
  private readonly notices = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  private pending = 0;
  private stream?: Promise<void>;

  constructor(input: GoalRuntimeOptions) {
    this.options = RuntimeOptionsSchema.parse(input.options ?? {});
    this.host = input.host; this.owner = input.owner; this.bridge = input.bridge;
    this.now = input.now ?? Date.now; this.uuid = input.uuid ?? (() => crypto.randomUUID());
    this.born = this.now();
    this.service = new GoalService({
      storage: input.storage, location: JSON.stringify([this.host.location.directory, this.host.location.workspaceID ?? null]),
      owner: input.owner.token, config: coreOptions(this.options), now: this.now, uuid: this.uuid, namespace: input.namespace,
    });
  }
  private alive(): void { if (this.dead) throw new GoalError("disposed", "Goal runtime is disposed"); }
  private invalidateRun(sessionID: string): void {
    const run = this.runs.get(sessionID);
    run?.controller.abort();
    // Deferred work has no outstanding task whose finally would retire it.
    if (run && !run.checking && this.runs.get(sessionID) === run) this.runs.delete(sessionID);
  }
  private invalidateRecovery(sessionID: string): void {
    this.recoveries.get(sessionID)?.controller.abort(); this.recoveries.delete(sessionID);
  }
  private ownershipLost(sessionID: string): void {
    this.epochs.set(sessionID, (this.epochs.get(sessionID) ?? 0) + 1);
    this.invalidateRun(sessionID); this.invalidateRecovery(sessionID);
    this.withdrawals.delete(sessionID); this.userTurns.delete(sessionID);
  }
  private async owned(sessionID: string): Promise<NativeSession> {
    this.alive();
    try { await this.owner.assertOwned(); }
    catch (error) { this.ownershipLost(sessionID); throw error; }
    this.alive();
    z.string().startsWith("ses").max(160).parse(sessionID);
    const session = await this.host.getSession(sessionID); this.alive();
    if (session.id !== sessionID || session.location.directory !== this.host.location.directory
      || session.location.workspaceID !== this.host.location.workspaceID) {
      this.ownershipLost(sessionID);
      throw new GoalError("conflict", "Session is not owned by this plugin location");
    }
    this.known.add(sessionID);
    return session;
  }
  private markBridgeFailure(error: unknown): void {
    this.bridgeState = "unavailable";
    this.diagnosticReason = error instanceof BridgeError ? error.code : "guard_unavailable";
  }
  /** State, not operation names, determines whether all owned future work must stop. */
  private async publishState(sessionID: string, state: SessionEnvelope | null): Promise<void> {
    if (!state?.current) return;
    // A delayed observer may finish after a newer lifecycle has already published.
    if (state.revision > (this.publishedRevision.get(sessionID) ?? -1)) {
      this.publishedRevision.set(sessionID, state.revision);
      const previous = this.lastFence.get(sessionID);
      this.lastFence.set(sessionID, fenceOf(state));
      const recovery = this.recoveries.get(sessionID);
      if (recovery && !sameFence(state, recovery)) this.invalidateRecovery(sessionID);
      if (previous && !sameFence(state, previous) && (state.current.status !== "active" || state.dispatch && ["invalidated", "ambiguous"].includes(state.dispatch.phase))) {
        this.epochs.set(sessionID, (this.epochs.get(sessionID) ?? 0) + 1);
        this.invalidateRun(sessionID);
      }
      if (!state.dispatch || this.withdrawals.get(sessionID)?.id !== state.dispatch.id) this.withdrawals.delete(sessionID);
      if (terminal(state)) this.userTurns.delete(sessionID);
    }
    // Retry exact owned withdrawal on later observations too: an admission may
    // have become visible after the first stop. Never cancel a foreign inbox ID.
    await this.withdrawInvalidated(sessionID, state);
  }
  private assertDecision(sessionID: string, epoch: number, source?: Run): void {
    this.alive();
    if (this.observation !== "observing") throw new GoalError("recovery_required", "Execution observation is unavailable");
    if (this.moved.has(sessionID) || this.epochs.get(sessionID) !== epoch
      || source && (source.controller.signal.aborted || this.runs.get(sessionID) !== source))
      throw new GoalError("invalid_transition", "Scheduler decision invalidated");
  }
  private async policy(session: NativeSession, source: Invocation): Promise<GoalAccess> {
    let id = source.agent ?? session.agent;
    if (!id) {
      try {
        id = await this.bridge.defaultAgent(this.controller.signal, this.host.location.directory) ?? this.lastAgent.get(session.id);
        this.bridgeState = "verified";
      }
      catch (error) { this.markBridgeFailure(error); }
    }
    // A last observed context agent is host evidence, never a blind build fallback.
    let allowed = false;
    if (id) {
      try { allowed = executionPolicy(session, await this.host.getAgent(id), this.options.allowAgents); }
      catch { allowed = false; }
    }
    return { actor: { kind: source.kind, ...(id ? { id } : {}) }, executionAllowed: allowed };
  }
  private async observed(sessionID: string, source: Invocation) {
    const session = await this.owned(sessionID);
    if (source.agent) this.lastAgent.set(sessionID, source.agent);
    let state = await this.service.get(sessionID);
    // Bind a running turn before any agent operation can replace its goal.
    const run = this.runs.get(sessionID);
    if (run && !run.fence && state?.current) run.fence = fenceOf(state);
    if (state?.current) state = await this.service.observeUsage(sessionID, session.tokens);
    await this.publishState(sessionID, state);
    return { session, state, access: await this.policy(session, source) };
  }
  diagnostics(sessionID?: string) {
    const recovery = sessionID ? this.recoveries.get(sessionID) : undefined;
    return DiagnosticsSchema.parse({
      autoContinue: this.options.autoContinue, bridge: this.bridgeState, reason: this.diagnosticReason,
      events: this.observation, usageAccountingOnly: true, alreadyDeliveredMayFinish: true,
      ...(recovery ? { recovery: recovery.waiting ? "waiting" : "scheduled" } : {}),
    });
  }
  /** Validated bookkeeping; authoritative observations may schedule runtime-owned recovery. */
  async manage(operation: Operation, sessionID: string, input: unknown, source: Invocation = { kind: "agent" }): Promise<SessionEnvelope | null> {
    this.alive();
    source.signal?.throwIfAborted();
    // Strict public parsing FIRST: actor/tokens/trustedRecovery/internal methods are not inputs.
    const parsed = ToolSchemas[operation]?.safeParse(input);
    if (!parsed?.success) throw new GoalError("validation", "Invalid public goal input or obsolete operation");
    const invocationEpoch = this.epochs.get(sessionID) ?? 0;
    this.epochs.set(sessionID, invocationEpoch);
    if (["pause", "block", "cancel", "complete"].includes(operation)) {
      this.epochs.set(sessionID, (this.epochs.get(sessionID) ?? 0) + 1);
      this.invalidateRun(sessionID); this.invalidateRecovery(sessionID);
      this.userTurns.delete(sessionID);
    }
    const { session, state, access } = await this.observed(sessionID, source);
    source.signal?.throwIfAborted();
    await this.owned(sessionID);
    let result: SessionEnvelope | null;
    switch (operation) {
      case "get": if (source.kind === "agent") this.reconsider(sessionID, state); return state;
      case "history": return state;
      case "create": result = await this.service.create({ ...ToolSchemas.create.parse(input), sessionID, tokens: session.tokens }, access); break;
      case "revise": result = await this.service.revise({ ...ToolSchemas.revise.parse(input), sessionID }, access); break;
      case "plan": result = await this.service.setPlan({ ...ToolSchemas.plan.parse(input), sessionID }, access); break;
      case "evidence": result = await this.service.recordEvidence({ ...ToolSchemas.evidence.parse(input), sessionID }, access); break;
      case "checkpoint": result = await this.service.checkpoint({ ...ToolSchemas.checkpoint.parse(input), sessionID }, access); break;
      case "complete": result = await this.service.complete({ ...ToolSchemas.complete.parse(input), sessionID }, access); break;
      case "block": result = await this.service.block({ ...ToolSchemas.block.parse(input), sessionID }, access); break;
      case "pause": result = await this.service.pause({ ...ToolSchemas.pause.parse(input), sessionID }, access); break;
      case "cancel": result = await this.service.cancel({ ...ToolSchemas.cancel.parse(input), sessionID }, access); break;
      case "resume": {
        const validate = () => {
          this.alive(); source.signal?.throwIfAborted();
          if (this.epochs.get(sessionID) !== invocationEpoch) throw new GoalError("invalid_transition", "Recovery superseded by newer session input or lifecycle");
        };
        const { recover, ...data } = ToolSchemas.resume.parse(input);
        if (this.observation === "failed") throw new GoalError("recovery_required", "Event observation failed; reload the runtime before execution can resume");
        if (!state?.current) throw new GoalError("no_goal", "No attached goal");
        if (state.current.status === "active") throw new GoalError("invalid_transition", "Goal is already active");
        if (["complete", "cancelled"].includes(state.current.status)) throw new GoalError("closed_goal", "Goal is closed");
        if (data.goalId !== state.current.id || data.expectedRevision !== state.current.revision)
          throw new GoalError("stale_revision", "Inspect the current goal before resuming");
        let trustedRecovery = false;
        if (recover || state.dispatch && !state.safetyPause) {
          if (!access.executionAllowed) throw new GoalError("execution_restricted", "Execution is not allowed by current policy");
          if (this.stagnant(state))
            throw new GoalError("recovery_required", "New substantive verification progress is required before recovery");
          const guard = await this.inspect(sessionID, state, true);
          validate();
          if (recover && (guard.active || guard.foreign || backgroundBusy(guard.background))) {
            if (this.moved.has(sessionID)) throw new GoalError("recovery_required", "Moved session has not reached a same-server reconciled boundary");
            // Do not wait on the caller's own execution from inside its tool call.
            // Only a later boundary/observation can reconcile and admit new work.
            this.reconsider(sessionID, state, true, source.commandStart === true);
            const pending = this.recoveries.get(sessionID);
            if (!pending || !sameFence(state, pending)) throw new GoalError("recovery_required", "Recovery could not be scheduled while execution observation is unavailable");
            return state;
          }
          if (await this.reconcile(sessionID, state, validate) === "waiting") {
            this.reconsider(sessionID, state, true, source.commandStart === true);
            const pending = this.recoveries.get(sessionID);
            if (!pending || !sameFence(state, pending)) throw new GoalError("recovery_required", "Recovery could not be scheduled while execution observation is unavailable");
            pending.waiting = true;
            return state;
          }
          trustedRecovery = recover; // Never copied from a caller assertion; reconciliation just succeeded.
        }
        result = await this.service.resume({ ...data, sessionID, tokens: session.tokens }, { ...access, trustedRecovery, explicitResume: recover });
        if (trustedRecovery) this.moved.delete(sessionID);
        break;
      }
    }
    await this.publishState(sessionID, result);
    if (result?.current) {
      // An agent may create its first goal during this execution. Bind it now,
      // not only on a later checkpoint/context call; never rebind a replacement.
      const run = this.runs.get(sessionID);
      if (operation === "create" && run && !run.fence) run.fence = fenceOf(result);
    }
    if (["checkpoint", "evidence", "plan"].includes(operation)) this.reconsider(sessionID, result);
    return result;
  }

  /** Plain bounded external result. Only tools.goals.get includes the full current record. */
  publicSnapshot(operation: Operation, state: SessionEnvelope | null): PublicResult {
    const goal = state?.current;
    let current: unknown = null;
    if (goal && operation === "get") {
      const { checkpointEvidence: _fingerprints, progress: _progress, dispatchProgress: _dispatch, noProgress: _noProgress, ...visible } = goal;
      current = FullGoalSchema.parse({ ...visible, view: "full" });
    } else if (goal) current = {
      view: "summary", id: goal.id, revision: goal.revision, generation: goal.generation,
      objective: goal.objective.slice(0, 500), status: goal.status, reason: goal.reason,
      limits: goal.limits, usage: goal.usage,
      acceptance: { total: goal.criteria.length, withEvidence: goal.criteria.filter(c => c.evidence.length).length },
      requiredStepsRemaining: goal.plan.filter(step => step.required && step.status !== "completed").length, inspect: "tools.goals.get",
    };
    return this.plain(PublicResultSchema.parse({
      ok: true, current,
      archives: (state?.archives ?? []).map(g => ({ id: g.id, objective: g.objective.slice(0, 300), status: g.status, updatedAt: g.updatedAt })),
      allowance: state?.allowance ?? null, diagnostics: this.diagnostics(state?.sessionID),
      ...(operation === "history" ? { history: state?.history ?? [] } : {}),
    }));
  }
  async call(operation: Operation, sessionID: string, input: unknown, source: Invocation = { kind: "agent" }): Promise<PublicResult> {
    try { return this.publicSnapshot(operation, await this.manage(operation, sessionID, input, source)); }
    catch (error) {
      // Core manage() stays strict; the public surface reports disposal as data.
      return { ok: false, error: {
        code: error instanceof GoalError ? error.code : error instanceof BridgeError ? `bridge_${error.code}` : "unavailable",
        message: error instanceof GoalError || error instanceof BridgeError ? error.message : "Goal operation unavailable; no unsafe fallback was used",
      } };
    }
  }
  private plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

  /** Native context/compaction hook. Never sets compaction.result. */
  async context(sessionID: string, agent: string, primary = true): Promise<string> {
    try {
      let observed: Awaited<ReturnType<GoalRuntime["observed"]>>;
      try { observed = await this.observed(sessionID, { kind: "agent", agent }); }
      catch (error) {
        // Hooks must not block unrelated locations if the host delivers broader traffic.
        if (error instanceof GoalError && error.code === "conflict") return "";
        throw error;
      }
      const { state, access } = observed;
      if (primary && state?.current && state.current.status === "active" && !access.executionAllowed) {
        const stopped = await this.service.pauseForSafety(sessionID, "restricted", "Current primary agent cannot execute goals", fenceOf(state));
        await this.publishState(sessionID, stopped);
      }
      const fresh = await this.service.get(sessionID);
      await this.publishState(sessionID, fresh);
      this.reconsider(sessionID, fresh);
      const budget = this.options.contextChars - POLICY.length - 1;
      return POLICY + "\n" + (budget >= 1000 ? renderGoalContext(fresh, budget) : "Goal context omitted=true: call tools.goals.get through execute for fresh state before acting or completing.");
    } catch (error) {
      // Disposed hooks stay read-only: no stored task text, no further writes.
      if (error instanceof GoalError && error.code === "disposed")
        return POLICY + "\n" + "Goal runtime unavailable=true: reload and call tools.goals.get through execute for fresh state before acting or completing.";
      throw error;
    }
  }

  private tag(dispatch: Dispatch, kind: "continue" | "start"): Admission["metadata"] {
    return { goals: { source: TAG, kind, owner: this.owner.token, id: dispatch.id, goalId: dispatch.goalId, generation: dispatch.generation } };
  }
  /** Admission hook: reject stale plugin admissions, never rewrite user text. */
  async guardPrompt(input: { sessionID: string; messageID: string; metadata?: Record<string, unknown> }): Promise<void> {
    const raw = input.metadata?.goals;
    const tagged = raw && typeof raw === "object" && "source" in raw && raw.source === TAG;
    try { await this.owned(input.sessionID); }
    catch (error) {
      if (error instanceof GoalError && error.code === "conflict" && !tagged) return;
      // Disposed foreign input yields; tagged admissions still reject below.
      if (error instanceof GoalError && error.code === "disposed" && !tagged) return;
      throw error;
    }
    if (raw && typeof raw === "object" && "source" in raw && raw.source === TAG) {
      const tag = z.object({ source: z.literal(TAG), kind: z.enum(["continue", "start"]), owner: z.string(), id: z.string(), goalId: z.string(), generation: z.number() }).safeParse(raw);
      const intent = this.admitting.get(input.sessionID);
      if (!tag.success || !intent || intent.id !== input.messageID || tag.data.id !== input.messageID
        || tag.data.owner !== this.owner.token || tag.data.goalId !== intent.goalId || tag.data.generation !== intent.generation)
        throw new GoalError("invalid_transition", "Stale goal admission rejected");
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      const state = await this.service.get(input.sessionID);
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      await this.publishState(input.sessionID, state);
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      if (!sameFence(state, intent)
        || state!.current!.status !== "active" || state!.dispatch?.id !== intent.id || state!.dispatch.phase !== "reserved")
        throw new GoalError("invalid_transition", "Stale goal admission rejected");
      const session = await this.owned(input.sessionID);
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      const policy = await this.policy(session, { kind: "agent" });
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      if (!policy.executionAllowed) throw new GoalError("execution_restricted", "Goal admission agent is restricted");
      // Guard rechecks bridge identity and pending state immediately at native admission.
      const guard = await this.inspect(input.sessionID, state!, true);
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      if (guard.active || guard.foreign || backgroundBusy(guard.background)) throw new GoalError("invalid_transition", "Newer session work has priority");
      const fresh = await this.service.get(input.sessionID);
      // Check AFTER the await, not in the left side of an expression that awaits.
      this.assertDecision(input.sessionID, intent.epoch, intent.source);
      if (!sameFence(fresh, intent) || fresh!.current!.status !== "active" || fresh!.dispatch?.id !== intent.id || fresh!.dispatch.phase !== "reserved")
        throw new GoalError("invalid_transition", "Goal lifecycle changed during admission guard");
      return;
    }
    // Yield to all foreign user input. Do not modify it or interrupt its execution.
    // Late disposal during these service reads yields without further writes.
    try {
      this.epochs.set(input.sessionID, (this.epochs.get(input.sessionID) ?? 0) + 1);
      this.invalidateRun(input.sessionID);
      this.invalidateRecovery(input.sessionID);
      if (this.userTurns.has(input.sessionID) || this.userTurns.size < 128) this.userTurns.set(input.sessionID, input.messageID);
      else void this.observationFailed(); // Never evict another pending authorization to admit a new one.
      const state = await this.service.get(input.sessionID);
      if (state?.current?.status === "active") {
        await this.publishState(input.sessionID, await this.service.yieldInput(input.sessionID));
      }
    } catch (error) {
      if (error instanceof GoalError && error.code === "disposed") return;
      throw error;
    }
  }

  private async inspect(sessionID: string, state: SessionEnvelope, allowOwnedIntent: boolean) {
    await this.owned(sessionID);
    const snapshot = await this.bridge.inspect(sessionID, this.controller.signal);
    this.bridgeState = "verified"; this.diagnosticReason = undefined;
    const permissions = await this.host.permissions(sessionID);
    const background = await this.bridge.background(sessionID, this.host.location, this.controller.signal);
    this.alive();
    try { await this.owner.assertOwned(); }
    catch (error) { this.ownershipLost(sessionID); throw error; }
    const foreign = permissions.length > 0 || snapshot.forms.length > 0 || snapshot.inbox.some(item => {
      if (item.type === "synthetic" && this.notices.has(item.id)) return false;
      return !(allowOwnedIntent && item.id === state.dispatch?.id);
    });
    return { ...snapshot, foreign, background };
  }
  private async eligible(sessionID: string, fence: Fence, epoch: number, allowIntent: boolean, source?: Run, deferBackground = false) {
    this.assertDecision(sessionID, epoch, source);
    const session = await this.owned(sessionID);
    this.assertDecision(sessionID, epoch, source);
    const state = await this.service.get(sessionID);
    this.assertDecision(sessionID, epoch, source);
    await this.publishState(sessionID, state);
    this.assertDecision(sessionID, epoch, source);
    if (!sameFence(state, fence) || state!.current!.status !== "active") throw new GoalError("invalid_transition", "Goal lifecycle changed");
    const access = await this.policy(session, { kind: "agent" });
    this.assertDecision(sessionID, epoch, source);
    if (!access.executionAllowed) throw new GoalError("execution_restricted", "Current agent cannot execute goals");
    const guard = await this.inspect(sessionID, state!, allowIntent);
    this.assertDecision(sessionID, epoch, source);
    if (guard.active || guard.foreign) throw new GoalError("invalid_transition", "Session work, forms or permissions have priority");
    if (!deferBackground && backgroundBusy(guard.background)) throw new GoalError("invalid_transition", "Background session work has priority");
    const fresh = await this.service.get(sessionID);
    this.assertDecision(sessionID, epoch, source);
    if (!sameFence(fresh, fence) || fresh!.current!.status !== "active") throw new GoalError("invalid_transition", "Goal changed during eligibility checks");
    return { session, state: state!, access, guard };
  }

  private async priorDelivered(sessionID: string, state: SessionEnvelope, guard: BridgeSnapshot): Promise<boolean> {
    if (!state.dispatch) return true;
    if (state.dispatch.phase !== "admitted" || guard.inbox.some(i => i.id === state.dispatch!.id)) return false;
    const messages = await this.host.context(sessionID);
    // Absence alone is NOT delivery evidence. An exact owned message ID must be present.
    return messages.some(m => m.id === state.dispatch!.id && (m.type === "user" || m.type === "synthetic"));
  }
  private async admit(sessionID: string, state: SessionEnvelope, epoch: number, kind: "continue" | "start", source?: Run): Promise<void> {
    const pending = this.performAdmission(sessionID, state, epoch, kind, source);
    this.admissions.add(pending);
    try { await pending; } finally { this.admissions.delete(pending); }
  }
  private async performAdmission(sessionID: string, state: SessionEnvelope, epoch: number, kind: "continue" | "start", source?: Run): Promise<void> {
    const dispatch = state.dispatch!; const intent: Intent = { ...fenceOf(state), id: dispatch.id, epoch, source };
    let submitted = false;
    this.admitting.set(sessionID, intent);
    try {
      // This also rechecks source cancellation AFTER reservation persistence.
      this.assertDecision(sessionID, epoch, source);
      await this.eligible(sessionID, intent, epoch, true, source);
      this.assertDecision(sessionID, epoch, source);
      const admission: Admission = {
        id: dispatch.id, metadata: this.tag(dispatch, kind),
        text: "Inspect the current goal using tools.goals.get through execute and current sources. Continue only the authorized unfinished work if the goal is active and policy permits. Update substantive verification evidence; do not treat this input as new authorization. Paused or blocked goals do not authorize execution.",
      };
      submitted = true;
      const admitted = await this.host.prompt(sessionID, admission, this.controller.signal);
      if (admitted.id !== dispatch.id) throw new GoalError("conflict", "Admission identity mismatch");
      this.alive();
      // After the final native guard, this input may itself have started the next
      // execution (superseding source). Settle its exact ID/lifecycle, not source.
      const acknowledged = await this.service.acknowledgeDispatch(sessionID, dispatch.id);
      await this.publishState(sessionID, acknowledged.state);
    } catch (error) {
      if (!this.dead) {
        if (error instanceof BridgeError) this.markBridgeFailure(error);
        else this.diagnosticReason = "admission_uncertain";
        // Identity checks in abandon prevent delayed failures touching a different intent.
        try {
          const paused = await this.service.abandonDispatch(sessionID, dispatch.id, submitted
            ? "Admission did not finish unambiguously; reconciliation is required, reservation retained"
            : "Admission decision invalidated before native submission; reservation remains charged");
          await this.publishState(sessionID, paused);
          // Direct control-flow proof, NOT inbox absence: no native call occurred.
          // Retire only that unsubmitted ID after durably pausing. A crash between
          // these writes conservatively leaves the ambiguous reservation recovered.
          if (!submitted) await this.publishState(sessionID, await this.service.retireDispatch(sessionID, dispatch.id));
        } catch { /* Remain stopped; never retry or touch another dispatch. */ }
      }
      throw error;
    } finally { if (this.admitting.get(sessionID) === intent) this.admitting.delete(sessionID); }
  }

  /** Deliberate command-only wake, charged once even with autoContinue disabled. */
  async start(sessionID: string): Promise<StartResult> {
    const { state } = await this.observed(sessionID, { kind: "human" });
    if (!state?.current) throw new GoalError("no_goal", "No attached goal");
    const epoch = this.epochs.get(sessionID) ?? 0; this.epochs.set(sessionID, epoch);
    const checked = await this.eligible(sessionID, fenceOf(state), epoch, false);
    const reserved = await this.service.reserveStart({ sessionID, ...fenceOf(state), tokens: checked.session.tokens }, { ...checked.access, actor: { kind: "human" } });
    const admissionId = reserved.dispatch!.id;
    await this.admit(sessionID, reserved, epoch, "start");
    const final = (await this.service.get(sessionID))!;
    return { kind: final.dispatch?.phase === "admitted" ? "admitted" : "withdrawal_requested", admissionId, state: final };
  }
  /** Passive notice is queued status information, not immediate transcript/UI output. */
  async notify(sessionID: string, text: string): Promise<void> {
    await this.owned(sessionID);
    const id = `msg_${this.uuid()}`;
    if (this.notices.size >= 128) throw new GoalError("validation", "Passive notice capacity reached");
    this.notices.add(id);
    await this.host.notify(sessionID, { id, text: z.string().trim().min(1).max(12000).parse(text), metadata: { goals: { source: TAG, kind: "notice", owner: this.owner.token, id } } }, this.controller.signal);
  }

  private watchDispatch(sessionID: string, state: SessionEnvelope): Withdrawal {
    const dispatch = state.dispatch!;
    const prior = this.withdrawals.get(sessionID);
    if (prior?.id === dispatch.id && prior.goalId === dispatch.goalId) return prior;
    if (state.revision < (this.publishedRevision.get(sessionID) ?? -1))
      throw new GoalError("invalid_transition", "Stale dispatch observation cannot replace current proof tracking");
    if (!prior && this.withdrawals.size >= 128) {
      void this.observationFailed();
      throw new GoalError("recovery_required", "Owned dispatch observation capacity reached");
    }
    const expected: Withdrawal = { id: dispatch.id, goalId: dispatch.goalId, confirmed: false, requested: false };
    this.withdrawals.set(sessionID, expected);
    return expected;
  }
  private async requestCancellation(sessionID: string, state: SessionEnvelope): Promise<void> {
    // Register BEFORE DELETE: the committed native event may beat its HTTP response.
    const expected = this.watchDispatch(sessionID, state);
    if (expected.requested) { await expected.pending; return; }
    expected.requested = true;
    const pending = this.bridge.cancel(sessionID, expected.id, this.controller.signal);
    expected.pending = pending;
    try { await pending; }
    catch (error) { expected.requested = false; throw error; }
    finally { expected.pending = undefined; }
    // 204 (including a delivered/missing-item no-op) proves NOTHING about withdrawal.
  }
  private async withdrawInvalidated(sessionID: string, state: SessionEnvelope): Promise<void> {
    if (!state.dispatch || !["invalidated", "ambiguous"].includes(state.dispatch.phase)) return;
    try {
      await this.owned(sessionID);
      const snapshot = await this.bridge.inspect(sessionID, this.controller.signal);
      if (snapshot.inbox.some(i => i.id === state.dispatch!.id)) {
        await this.requestCancellation(sessionID, state);
      }
      // Keep the durable intent until explicit reconciliation; absence/cancel-204 is not proof of non-delivery.
    } catch (error) { this.markBridgeFailure(error); }
  }
  private async reconcile(sessionID: string, initial: SessionEnvelope, validate: () => void = () => {}): Promise<"reconciled" | "waiting"> {
    const expected = fenceOf(initial);
    validate();
    if (this.admitting.has(sessionID)) throw new GoalError("recovery_required", "Admission is still in flight; wait for its outcome before recovery");
    const guard = await this.inspect(sessionID, initial, true);
    validate();
    if (guard.active || guard.foreign || backgroundBusy(guard.background)) return "waiting";
    const dispatch = initial.dispatch;
    const expectedWithdrawal = dispatch ? this.watchDispatch(sessionID, initial) : undefined;
    const pending = dispatch && guard.inbox.some(item => item.id === dispatch.id);
    if (pending) await this.requestCancellation(sessionID, initial);
    validate();
    const messages = await this.host.context(sessionID);
    validate();
    const after = await this.inspect(sessionID, initial, true);
    validate();
    if (after.active || after.foreign || backgroundBusy(after.background) || dispatch && after.inbox.some(item => item.id === dispatch.id))
      return "waiting";
    if (dispatch) {
      const delivered = messages.some(m => m.id === dispatch.id && ["user", "synthetic"].includes(m.type));
      // Only the exact native post-commit cancellation event or exact delivered
      // context is proof. Presence + DELETE 204 + absence is a delivery race too.
      if (!expectedWithdrawal!.confirmed && !delivered) return "waiting";
    }
    const fresh = await this.service.get(sessionID);
    validate();
    if (!sameFence(fresh, expected) || fresh!.current!.revision !== initial.current!.revision)
      throw new GoalError("invalid_transition", "Lifecycle changed during reconciliation");
    if (dispatch) {
      await this.service.retireDispatch(sessionID, dispatch.id);
      if (this.withdrawals.get(sessionID) === expectedWithdrawal) this.withdrawals.delete(sessionID);
    }
    // Never replay the old ID. Explicit resume may later admit a NEW bounded start.
    return "reconciled";
  }

  private stagnant(state: SessionEnvelope): boolean {
    const goal = state.current;
    return !!goal && goal.progress <= goal.dispatchProgress && (goal.reason === "no_progress"
      || state.safetyPause?.reason === "no_progress" || goal.noProgress >= this.options.maxNoProgress);
  }
  private recoverable(state: SessionEnvelope, explicit: boolean, reconciled = false): boolean {
    const goal = state.current;
    if (!goal || !(goal.status === "paused" || explicit && goal.status === "blocked")) return false;
    if (!explicit && state.explicitStop) return false;
    if (this.stagnant(state)) return false;
    if (explicit) return true;
    // Proven non-submission is not a license to repeatedly retry a late-arrival
    // race. An outstanding ambiguity requires positive delivery/cancellation proof.
    if (goal.reason === "ambiguous" && !state.dispatch && !reconciled) return false;
    return ["restart", "runtime_failure", "ambiguous", "no_progress"].includes(goal.reason ?? "");
  }
  /** One coalesced, lifecycle-fenced intent per owned session. No timers or polling. */
  private reconsider(sessionID: string, state: SessionEnvelope | null, explicit = false, commandStart = false): void {
    const requested = explicit;
    const pending = this.recoveries.get(sessionID);
    if (!this.dead && this.observation === "observing" && !this.moved.has(sessionID)
      && pending?.ready && sameFence(state, pending) && state?.current?.status === "active") {
      this.scheduleRecovery(sessionID, pending); return;
    }
    // A genuinely new native user turn may explicitly reconsider unsuccessful
    // work; a generated continuation and repeated observations cannot do so.
    const authorizationId = !explicit && this.options.autoContinue && ["failed", "interrupted"].includes(state?.current?.reason ?? "") && !state?.explicitStop
      ? this.userTurns.get(sessionID) : undefined;
    explicit ||= !!authorizationId;
    if (this.dead || this.observation !== "observing" || this.moved.has(sessionID)
      || !state || (!this.options.autoContinue && !explicit) || !this.recoverable(state, explicit)) return;
    let recovery = this.recoveries.get(sessionID);
    if (!recovery || !sameFence(state, recovery)) {
      if (!recovery && this.recoveries.size >= 128) { void this.observationFailed(); return; }
      const epoch = this.epochs.get(sessionID) ?? 0; this.epochs.set(sessionID, epoch);
      recovery = { ...fenceOf(state), epoch, explicit, commandStart, authorizationId, waitingDispatch: state.dispatch?.id, ready: false, checking: false, waiting: false, boundary: false, controller: new AbortController() };
      this.recoveries.set(sessionID, recovery);
    } else {
      recovery.explicit ||= explicit; recovery.commandStart ||= commandStart;
      if (requested) recovery.authorizationId = undefined;
    }
    this.scheduleRecovery(sessionID, recovery);
  }
  private scheduleRecovery(sessionID: string, recovery: Recovery, boundary = false): void {
    recovery.boundary ||= boundary;
    if (recovery.checking) return;
    recovery.checking = true; recovery.completions = new Set();
    this.enqueue(sessionID, () => this.recover(sessionID, recovery));
  }
  private async recover(sessionID: string, recovery: Recovery): Promise<void> {
    const validate = () => {
      this.assertDecision(sessionID, recovery.epoch);
      if (this.recoveries.get(sessionID) !== recovery) throw new GoalError("invalid_transition", "Recovery superseded");
    };
    let deferred = false;
    try {
      validate();
      if (recovery.boundary) {
        recovery.boundary = false;
        await this.host.wait(sessionID, AbortSignal.any([this.controller.signal, recovery.controller.signal])); validate();
      }
      const session = await this.owned(sessionID); validate();
      const state = await this.service.get(sessionID); validate();
      if (!state || !sameFence(state, recovery)
        || !(recovery.ready ? state.current!.status === "active" && !state.explicitStop : this.recoverable(state, recovery.explicit))) return;
      const access = await this.policy(session, { kind: "agent" }); validate();
      if (!access.executionAllowed) return;
      if (recovery.authorizationId) {
        const messages = await this.host.context(sessionID); validate();
        // A foreign synthetic/queued input alone is not fresh user authorization
        // to retry unsuccessful work. Require the exact native user projection.
        if (!messages.some(message => message.id === recovery.authorizationId && message.type === "user")) return;
      }
      const guard = await this.inspect(sessionID, state, true); validate();
      if (guard.active || guard.foreign || backgroundBusy(guard.background)) {
        recovery.background = guard.background; recovery.waiting = true; deferred = true; return;
      }
      recovery.background = undefined;
      if (!recovery.ready) {
        recovery.waitingDispatch = state.dispatch?.id;
        const reconciled = await this.reconcile(sessionID, state, validate); validate();
        if (reconciled === "waiting") { recovery.waiting = true; deferred = true; return; }
        recovery.waitingDispatch = undefined;
        const fresh = await this.service.get(sessionID); validate();
        if (!fresh || !sameFence(fresh, recovery) || !this.recoverable(fresh, recovery.explicit, true)) return;
        const resumed = await this.service.resume({ sessionID, goalId: fresh.current!.id, expectedRevision: fresh.current!.revision, tokens: session.tokens }, { ...access, trustedRecovery: true, explicitResume: recovery.explicit && !recovery.authorizationId });
        validate();
        // Follow only our own validated resume into its new lifecycle. Preserve
        // the pending handoff if background work arrives before reservation.
        Object.assign(recovery, fenceOf(resumed)); recovery.ready = true;
        await this.publishState(sessionID, resumed);
      }
      if (!this.options.autoContinue && !recovery.commandStart) return;
      deferred = true; recovery.waiting = true;
      const checked = await this.eligible(sessionID, recovery, recovery.epoch, false, undefined, true); validate();
      if (backgroundBusy(checked.guard.background)) { recovery.background = checked.guard.background; return; }
      deferred = false;
      const reserved = await this.service.reserveStart({ sessionID, goalId: recovery.goalId, generation: recovery.generation, tokens: checked.session.tokens },
        recovery.commandStart ? { ...checked.access, actor: { kind: "human" } } : checked.access);
      await this.admit(sessionID, reserved, recovery.epoch, recovery.commandStart ? "start" : "continue");
    } catch (error) {
      if (error instanceof BridgeError) this.markBridgeFailure(error);
      // Fail closed. A new trustworthy observation may reconsider an internal hold;
      // no failed observation itself authorizes another attempt.
    } finally {
      recovery.checking = false;
      if (deferred && this.recoveries.get(sessionID) === recovery) {
        if (recovery.boundary || recovery.deliveryRecheck || recovery.background && backgroundKeys(recovery.background).some(key => recovery.completions?.has(key))) {
          recovery.deliveryRecheck = false;
          this.scheduleRecovery(sessionID, recovery);
        }
      } else if (this.recoveries.get(sessionID) === recovery) this.recoveries.delete(sessionID);
      if (!recovery.checking) recovery.completions = undefined;
    }
  }

  startObserving(): void {
    this.alive(); if (this.stream) return;
    this.observation = "observing";
    this.stream = (async () => {
      try {
        for await (const event of this.host.events(this.controller.signal)) this.acceptEvent(event);
        if (!this.dead) await this.observationFailed();
      } catch { if (!this.dead) await this.observationFailed(); }
    })();
  }
  private enqueue(sessionID: string, task: () => Promise<void>): void {
    if (this.dead || this.observation === "failed") return;
    if (this.pending >= 128 || (this.depths.get(sessionID) ?? 0) >= 32) { void this.observationFailed(); return; }
    this.pending++; this.depths.set(sessionID, (this.depths.get(sessionID) ?? 0) + 1);
    const previous = this.queues.get(sessionID) ?? Promise.resolve();
    const tail = previous.then(async () => { if (!this.dead) await task(); }).catch(() => { this.diagnosticReason = "event_task_unavailable"; }).finally(() => {
      this.pending--; this.depths.set(sessionID, (this.depths.get(sessionID) ?? 1) - 1);
      if (this.queues.get(sessionID) === tail) this.queues.delete(sessionID);
    });
    this.queues.set(sessionID, tail);
  }
  /** Event consumer entrypoint, also an owned test boundary. Does not await slow work. */
  acceptEvent(raw: unknown): void {
    if (this.dead || this.observation !== "observing") return;
    // Shell terminal events have no sessionID. Correlate exact IDs against each
    // bounded pending inspection, never against globally active random sessions.
    const shell = z.object({ type: z.literal("shell.exited"), created: z.number().finite(),
      data: z.object({ id: z.string(), status: z.enum(["exited", "timeout", "killed"]) }) }).safeParse(raw);
    if (shell.success) { this.backgroundCompleted(`shell:${shell.data.data.id}`); return; }
    const result = EVENT.safeParse(raw); if (!result.success) return;
    const event = result.data; const id = event.data.sessionID;
    if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type))
      this.backgroundCompleted(`child:${id}`);
    const local = event.location?.directory === this.host.location.directory && event.location?.workspaceID === this.host.location.workspaceID;
    if (event.type === "session.moved" && this.known.has(id)) {
      this.moved.add(id); this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      this.invalidateRun(id); this.invalidateRecovery(id);
      this.withdrawals.delete(id); this.userTurns.delete(id);
      this.enqueue(id, async () => { await this.publishState(id, await this.service.pauseForSafety(id, "restart", "Session moved; explicit same-server reconciliation is required")); });
      return;
    }
    // 2.0.25 execution events omit location, including the first start BEFORE a
    // context/tool call establishes ownership. Retain only a bounded provisional
    // start; queued native ownership verification must succeed before any action.
    const execution = event.type.startsWith("session.execution.");
    if (!local && !(event.location === undefined && (this.known.has(id)
      || execution && (event.type === "session.execution.started" || this.runs.has(id))))) return;
    if (event.type === "session.execution.started") {
      if (event.created < this.born || event.created <= (this.lastStarted.get(id) ?? -1)) return;
      if (!this.runs.has(id) && this.runs.size >= 128) { void this.observationFailed(); return; }
      this.lastStarted.set(id, event.created);
      // Capture known identity synchronously. A slow later lookup must not bind an
      // old execution failure to a goal created after this event.
      this.runs.get(id)?.controller.abort();
      const run: Run = { started: event.created, fence: this.lastFence.get(id), controller: new AbortController() };
      this.runs.set(id, run);
      this.enqueue(id, async () => {
        try { await this.owned(id); }
        catch (error) {
          if (this.runs.get(id) === run) this.runs.delete(id);
          if (!this.known.has(id) && this.lastStarted.get(id) === event.created) this.lastStarted.delete(id);
          run.controller.abort();
          if (!(error instanceof GoalError && error.code === "conflict")) throw error;
        }
      });
    } else if (event.type === "session.execution.succeeded") {
      const recovery = this.recoveries.get(id);
      if (recovery && event.created >= this.born) this.scheduleRecovery(id, recovery, true);
      this.userTurns.delete(id);
      const run = this.runs.get(id);
      if (!run || event.created < run.started || run.success !== undefined) return;
      run.success = event.created;
      if (!run.fence) { this.runs.delete(id); run.controller.abort(); return; }
      const fence = run.fence;
      const epoch = this.epochs.get(id) ?? 0; this.epochs.set(id, epoch);
      // Successful execution is the native terminal signal. There is no emitted
      // session.idle event in 2.0.25; wait for quiescence before reading its message.
      this.scheduleSuccess(id, run, fence, epoch);
    } else if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
      this.userTurns.delete(id);
      this.invalidateRecovery(id);
      const run = this.runs.get(id);
      if (!run || event.created < run.started) return;
      run.controller.abort();
      this.runs.delete(id);
      if (!run?.fence) return; const expected = run.fence;
      this.enqueue(id, async () => {
        await this.owned(id);
        const state = await this.service.pauseForSafety(id, event.type.endsWith("failed") ? "failed" : "interrupted", "Execution stopped unsuccessfully; do not blindly retry", expected);
        await this.publishState(id, state);
      });
    } else if (event.type === "session.usage.updated" || event.type === "session.usage.recorded") {
      this.enqueue(id, async () => { const { state } = await this.observed(id, { kind: "agent", agent: this.lastAgent.get(id) }); this.reconsider(id, state); });
    } else if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
      const inboxID = event.data.inboxID;
      if (typeof inboxID !== "string") return;
      this.notices.delete(inboxID);
      const expected = this.withdrawals.get(id);
      if (!expected || expected.id !== inboxID || this.moved.has(id)) return;
      // Pinned V2 publishes InboxCancelled only after its conditional DELETE
      // transaction commits. HTTP conflict/no-op 204 never emits this event.
      if (event.type === "session.inbox.cancelled") {
        if (expected.confirmed) return;
        expected.confirmed = true;
      }
      const recovery = this.recoveries.get(id);
      if (recovery?.waitingDispatch === inboxID) {
        if (recovery.checking) recovery.deliveryRecheck = true;
        else this.scheduleRecovery(id, recovery);
      }
      const run = this.runs.get(id);
      if (run?.waitingDispatch === inboxID && run.fence && run.success !== undefined && !run.controller.signal.aborted) {
        if (run.checking) run.deliveryRecheck = true;
        else this.scheduleSuccess(id, run, run.fence, this.epochs.get(id) ?? 0);
      }
    }
  }
  private backgroundCompleted(key: string): void {
    for (const [id, recovery] of this.recoveries) {
      if (recovery.checking) {
        recovery.completions ??= new Set();
        if (recovery.completions.size >= 128 && !recovery.completions.has(key)) { void this.observationFailed(); return; }
        recovery.completions.add(key);
      } else if (recovery.background && backgroundKeys(recovery.background).includes(key)) this.scheduleRecovery(id, recovery);
    }
    for (const [id, run] of this.runs) {
      if (run.success === undefined || !run.fence || run.controller.signal.aborted) continue;
      if (run.checking) {
        // Covers completion between the native snapshot read and its return.
        // No polling, timers, or unbounded completed-job history.
        run.completions ??= new Set();
        if (run.completions.size >= 128 && !run.completions.has(key)) { void this.observationFailed(); return; }
        run.completions.add(key);
      } else if (run.background && backgroundKeys(run.background).includes(key)) {
        this.scheduleSuccess(id, run, run.fence, this.epochs.get(id) ?? 0);
      }
    }
  }
  private scheduleSuccess(id: string, run: Run, fence: Fence, epoch: number): void {
    if (run.checking) return;
    run.checking = true; run.completions = new Set();
    this.enqueue(id, () => this.onSuccess(id, run, fence, epoch));
  }
  private async onSuccess(sessionID: string, run: Run, fence: Fence, epoch: number): Promise<void> {
    const current = () => !this.dead && this.observation === "observing" && !run.controller.signal.aborted
      && this.runs.get(sessionID) === run && this.epochs.get(sessionID) === epoch;
    let deferred = false;
    try {
      if (!this.options.autoContinue || !current()) return;
      await this.owned(sessionID);
      if (!current()) return;
      await this.host.wait(sessionID, AbortSignal.any([this.controller.signal, run.controller.signal]));
      if (!current()) return;
      const checked = await this.eligible(sessionID, fence, epoch, true, run, true);
      if (!current()) return;
      if (backgroundBusy(checked.guard.background)) {
        run.background = checked.guard.background; deferred = true; return;
      }
      run.background = undefined;
      run.waitingDispatch = checked.state.dispatch?.id;
      if (checked.state.dispatch?.phase === "invalidated") {
        // Ordinary follow-up superseded an older owned admission but kept the
        // goal active. Reconcile that exact ID before using this new boundary.
        if (await this.reconcile(sessionID, checked.state, () => this.assertDecision(sessionID, epoch, run)) === "waiting") { deferred = true; return; }
      } else if (checked.state.dispatch) {
        this.watchDispatch(sessionID, checked.state);
        if (!await this.priorDelivered(sessionID, checked.state, checked.guard)) { deferred = true; return; }
      }
      run.waitingDispatch = undefined;
      if (!current()) return;
      const messages = await this.host.context(sessionID);
      const idle = messages.filter(m => m.type === "idle").at(-1);
      // The persisted idle message precedes the succeeded event in this host.
      // Bound it to this fresh run and require the session's exact idle projection.
      if (!current() || !idle || idle.outcome !== "succeeded" || checked.session.outcome !== "succeeded"
        || idle.created < run.started || idle.created > run.success! || checked.session.idleTime !== idle.created) return;
      const reserved = await this.service.reserveDispatch({
        sessionID, ...fence, idle: { id: idle.id, time: idle.created, outcome: idle.outcome }, tokens: checked.session.tokens,
      }, checked.access);
      if (reserved.kind === "reserved") await this.admit(sessionID, reserved.state, epoch, "continue", run);
      else await this.publishState(sessionID, reserved.state);
    } catch (error) {
      if (!current()) return;
      if (error instanceof BridgeError) this.markBridgeFailure(error);
      // Guard rejections yield without waking unrelated work; missing safety observations pause.
      if (!(error instanceof GoalError) || error.code === "execution_restricted") {
        const state = await this.service.pauseForSafety(sessionID, error instanceof GoalError ? "restricted" : "runtime_failure", "Continuation safety checks unavailable or restricted", fence);
        await this.publishState(sessionID, state);
      }
    } finally {
      run.checking = false;
      if (deferred && current()) {
        if (run.deliveryRecheck || run.background && backgroundKeys(run.background).some(key => run.completions?.has(key))) {
          run.deliveryRecheck = false;
          this.scheduleSuccess(sessionID, run, fence, epoch);
        }
      } else {
        if (this.runs.get(sessionID) === run) this.runs.delete(sessionID);
        run.controller.abort();
      }
      if (!run.checking) run.completions = undefined;
    }
  }
  private async observationFailed(): Promise<void> {
    if (this.dead || this.observation === "failed") return;
    this.observation = "failed"; this.diagnosticReason = "event_stream_failed";
    this.userTurns.clear(); this.withdrawals.clear();
    for (const run of this.runs.values()) run.controller.abort();
    for (const id of this.recoveries.keys()) this.invalidateRecovery(id);
    for (const id of this.known) this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    for (const id of this.known) {
      try {
        await this.owned(id); const state = await this.service.get(id);
        if (state?.current && !terminal(state)) {
          const paused = await this.service.pauseForSafety(id, "runtime_failure", "Event observation stopped; automatic continuation is disabled");
          await this.publishState(id, paused);
        }
      } catch { /* Never enable automation when state/ownership cannot be observed. */ }
    }
  }
  async drain(): Promise<void> { while (this.queues.size) await Promise.all([...this.queues.values()]); }
  async dispose(): Promise<void> {
    if (this.dead) return;
    this.dead = true; this.controller.abort();
    this.userTurns.clear(); this.withdrawals.clear();
    // Core disposal synchronously fences captured executors before any await.
    const core = this.service.dispose();
    await Promise.allSettled([...this.queues.values(), ...this.admissions, ...(this.stream ? [this.stream] : []), core]);
    await this.owner.release();
  }
}
