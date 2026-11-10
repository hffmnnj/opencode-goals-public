import { Rpc } from "@opencode/plugin/rpc";
import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { defineGoalsPlugin } from "../../src/index.ts";
import { EnvelopeSchema, sessionStorageKey } from "../../src/schema.ts";

/** Private-host synchronization only; not included in the shipped plugin. */
const armedSession: { id: string | null } = { id: null };
type BufferedCancel = { inboxID: string | null; raw: unknown; count: number; released: boolean };
const bufferedCancel = new Map<string, BufferedCancel>();
const cancelWaiters = new Map<string, { resolve: () => void }>();

const inner = defineGoalsPlugin(async (ctx, runtime) => {
  const observed = new Map<string, number>();
  const waiting = new Map<string, { count: number; resolve: () => void }>();
  const forwardAccept = runtime.acceptEvent.bind(runtime);
  runtime.acceptEvent = raw => {
    // Buffer exactly one real committed native cancellation for the armed
    // session/dispatch instead of forwarding it immediately. The raw envelope
    // is retained post-commit; nothing is fabricated or mutated.
    const cancel = z.object({ type: z.literal("session.inbox.cancelled"),
      data: z.object({ sessionID: z.string(), inboxID: z.string() }).passthrough() }).safeParse(raw);
    if (cancel.success) {
      const entry = bufferedCancel.get(cancel.data.data.sessionID);
      if (entry && entry.inboxID !== null && entry.inboxID === cancel.data.data.inboxID && !entry.released) {
        entry.raw = raw;
        entry.count++;
        const waiter = cancelWaiters.get(cancel.data.data.sessionID);
        if (waiter) { cancelWaiters.delete(cancel.data.data.sessionID); waiter.resolve(); }
        return;
      }
    }
    forwardAccept(raw);
    const parsed = z.object({ type: z.literal("session.execution.succeeded"), data: z.object({ sessionID: z.string() }) }).safeParse(raw);
    if (!parsed.success) return;
    const id = parsed.data.data.sessionID;
    if (!observed.has(id) && observed.size >= 128) throw new Error("Fixture capacity reached");
    const count = (observed.get(id) ?? 0) + 1; observed.set(id, count);
    const waiter = waiting.get(id);
    if (waiter && count >= waiter.count) { waiting.delete(id); waiter.resolve(); }
  };
  await ctx.rpc.register(Rpc.define({ id: "background-fixture", methods: {
    drain: { input: z.object({ sessionID: z.string(), count: z.number().int().positive() }), output: z.object({ drained: z.literal(true) }) },
    dispose: { input: z.object({}), output: z.object({ disposed: z.literal(true) }) },
    stored: { input: z.object({ sessionID: z.string() }), output: z.object({ autoTurns: z.number() }) },
    flush: { input: z.object({}), output: z.object({ flushed: z.literal(true) }) },
    envelope: { input: z.object({ sessionID: z.string() }), output: z.object({ autoTurns: z.number(), status: z.string().nullable(), reason: z.string().nullable(), dispatchId: z.string().nullable(), revision: z.number() }) },
    queuedStart: { input: z.object({ sessionID: z.string() }), output: z.object({ admissionId: z.string() }) },
    cancelStatus: { input: z.object({ sessionID: z.string() }), output: z.object({ buffered: z.boolean(), count: z.number(), inboxID: z.string().nullable() }) },
    awaitCancel: { input: z.object({ sessionID: z.string() }), output: z.object({ buffered: z.literal(true), count: z.number(), inboxID: z.string().nullable() }) },
    releaseCancellation: { input: z.object({ sessionID: z.string() }), output: z.object({ released: z.literal(true), inboxID: z.string() }) },
  }, events: {} }), {
    drain: async ({ sessionID, count }) => {
      if ((observed.get(sessionID) ?? 0) < count) await new Promise<void>(resolve => {
        if (waiting.has(sessionID) || waiting.size >= 128) throw new Error("Fixture waiter conflict");
        waiting.set(sessionID, { count, resolve });
      });
      await runtime.drain();
      return { drained: true as const };
    },
    dispose: async () => { await runtime.dispose(); return { disposed: true as const }; },
    stored: async ({ sessionID }) => {
      const location = JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? null]);
      const state = EnvelopeSchema.parse(await ctx.storage.get(sessionStorageKey(location, sessionID)));
      return { autoTurns: state.allowance.usage.autoTurns };
    },
    flush: async () => {
      await runtime.drain();
      return { flushed: true as const };
    },
    envelope: async ({ sessionID }) => {
      const location = JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? null]);
      const state = EnvelopeSchema.parse(await ctx.storage.get(sessionStorageKey(location, sessionID)));
      return {
        autoTurns: state.allowance.usage.autoTurns,
        status: state.current?.status ?? null,
        reason: state.current?.reason ?? null,
        dispatchId: state.dispatch?.id ?? null,
        revision: state.revision,
      };
    },
    queuedStart: async ({ sessionID }) => {
      if (armedSession.id !== null) throw new Error("Queued start already armed");
      armedSession.id = sessionID;
      bufferedCancel.set(sessionID, { inboxID: null, raw: null, count: 0, released: false });
      try {
        // Public guarded start, the same method the command adapter uses.
        // The facade below queues it with resume:false so no model wakes.
        const result = await runtime.start(sessionID);
        bufferedCancel.get(sessionID)!.inboxID = result.admissionId;
        return { admissionId: result.admissionId };
      } finally {
        armedSession.id = null;
      }
    },
    cancelStatus: async ({ sessionID }) => {
      const entry = bufferedCancel.get(sessionID);
      return { buffered: (entry?.count ?? 0) >= 1, count: entry?.count ?? 0, inboxID: entry?.inboxID ?? null };
    },
    awaitCancel: async ({ sessionID }) => {
      const ready = bufferedCancel.get(sessionID);
      if ((ready?.count ?? 0) >= 1) return { buffered: true as const, count: ready!.count, inboxID: ready!.inboxID };
      await new Promise<void>(resolve => {
        if (cancelWaiters.has(sessionID)) throw new Error("Fixture cancel waiter conflict");
        cancelWaiters.set(sessionID, { resolve });
        const raced = bufferedCancel.get(sessionID);
        if ((raced?.count ?? 0) >= 1) { cancelWaiters.delete(sessionID); resolve(); }
      });
      const after = bufferedCancel.get(sessionID)!;
      return { buffered: true as const, count: after.count, inboxID: after.inboxID };
    },
    releaseCancellation: async ({ sessionID }) => {
      const entry = bufferedCancel.get(sessionID);
      if (!entry || entry.count < 1 || !entry.raw || entry.inboxID === null || entry.released)
        throw new Error("No buffered cancellation to release for session");
      entry.released = true;
      // Forward ONLY the buffered real native event, then drain its queue.
      forwardAccept(entry.raw);
      await runtime.drain();
      return { released: true as const, inboxID: entry.inboxID };
    },
  });
});

export default {
  ...inner,
  async setup(ctx: Plugin.Context) {
    // Fixture-only wake control: exactly one armed real native prompt call is
    // queued with resume:false instead of resume:true. Native enqueue, guards,
    // storage, ownership and HTTP cancellation are untouched; only the wake
    // parameter changes for the controlled old queued owned start.
    const originalPrompt = ctx.session.prompt.bind(ctx.session);
    const wrappedPrompt = ((...args: Parameters<typeof originalPrompt>): ReturnType<typeof originalPrompt> => {
      const [input, options] = args;
      if (armedSession.id !== null && (input as { sessionID?: string }).sessionID === armedSession.id) {
        return originalPrompt({ ...(input as Record<string, unknown>), resume: false } as Parameters<typeof originalPrompt>[0], options);
      }
      return originalPrompt(...args);
    }) as typeof originalPrompt;
    return inner.setup({ ...ctx, session: { ...ctx.session, prompt: wrappedPrompt } });
  },
};
