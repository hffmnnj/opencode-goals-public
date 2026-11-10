import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { TokensSchema, type Tokens } from "./schema.ts";

export const RuleSchema = z.object({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "deny", "ask"]) });
export type Rule = z.infer<typeof RuleSchema>;
export interface NativeSession {
  id: string; location: { directory: string; workspaceID?: string }; tokens: Tokens;
  agent?: string; parentID?: string; fork?: unknown; permissions: Rule[];
  outcome?: "succeeded" | "failed" | "interrupted"; idleTime?: number;
}
export interface NativeMessage {
  id: string; type: string; created: number; metadata?: Record<string, unknown>;
  outcome?: "succeeded" | "failed" | "interrupted";
}
export interface NativeAgent { id: string; mode: string; permissions: Rule[] }
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Admission { id: string; metadata: { [key: string]: JsonValue }; text: string }
/** Small owned boundary: native APIs only, no discovery, permissions replies or agent switches. */
export interface NativeHost {
  location: { directory: string; workspaceID?: string };
  getSession(id: string): Promise<NativeSession>;
  context(id: string): Promise<NativeMessage[]>;
  /** Wait for the native agent loop to become idle; abort stops observation, not execution. */
  wait(id: string, signal: AbortSignal): Promise<void>;
  getAgent(id: string): Promise<NativeAgent>;
  permissions(id: string): Promise<readonly unknown[]>;
  prompt(id: string, admission: Admission, signal: AbortSignal): Promise<{ id: string }>;
  notify(id: string, admission: Admission, signal: AbortSignal): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<unknown>;
}

/** Host timestamps are Effect DateTimeUtc values, not always epoch numbers. */
export function epoch(value: unknown): number {
  if (typeof value === "object" && value !== null && "epochMilliseconds" in value) value = value.epochMilliseconds;
  return z.number().finite().nonnegative().parse(value);
}
export function nativeHost(ctx: Plugin.Context): NativeHost {
  type SessionID = Parameters<typeof ctx.session.get>[0]["sessionID"];
  const sessionID = (id: string) => z.string().startsWith("ses").parse(id) as SessionID;
  return {
    location: { directory: ctx.location.directory, ...(ctx.location.workspaceID ? { workspaceID: ctx.location.workspaceID } : {}) },
    async getSession(id) {
      const session = await ctx.session.get({ sessionID: sessionID(id) });
      return {
        // The pinned public Session DTO may omit workspaceID. Do not invent it from
        // ctx.location: a workspace instance must fail ownership checks if unverifiable.
        id: session.id, location: z.object({ directory: z.string(), workspaceID: z.string().optional() }).parse(session.location),
        tokens: TokensSchema.parse(session.tokens), agent: session.agent,
        parentID: session.parentID, fork: session.fork, permissions: z.array(RuleSchema).parse(session.permissions ?? []),
        outcome: session.outcome, idleTime: session.time.idle === undefined ? undefined : epoch(session.time.idle),
      };
    },
    async context(id) {
      const messages = await ctx.session.context({ sessionID: sessionID(id) });
      return messages.map(message => ({
        id: message.id, type: message.type, created: epoch(message.time.created),
        metadata: message.metadata,
        outcome: message.type === "idle" ? message.outcome : undefined,
      }));
    },
    async wait(id, signal) {
      signal.throwIfAborted();
      // Pinned session.wait waits for the agent loop to become idle. Its Promise
      // adapter ignores RequestOptions, so fence our observation explicitly. The
      // underlying read-only wait may finish later; never interrupt the session.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve().then(() => {
          signal.throwIfAborted();
          return ctx.session.wait({ sessionID: sessionID(id) });
        }).then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => {
          signal.removeEventListener("abort", abort); reject(error);
        });
      });
    },
    async getAgent(id) {
      const { data: agent, location } = await ctx.agent.get({ agentID: id as Parameters<typeof ctx.agent.get>[0]["agentID"] });
      if (location.directory !== ctx.location.directory) throw new Error("Agent policy location mismatch");
      return { id: agent.id, mode: agent.mode, permissions: z.array(RuleSchema).parse(agent.permissions) };
    },
    async permissions(id) {
      const pending = z.array(z.object({ id: z.string(), sessionID: z.string() })).parse(await ctx.permission.list({ sessionID: sessionID(id) }));
      if (pending.some(request => request.sessionID !== id)) throw new Error("Permission session mismatch");
      return pending;
    },
    async prompt(id, admission, signal) {
      const item = await ctx.session.prompt({ sessionID: sessionID(id), ...admission, delivery: "queue", resume: true }, { signal });
      return { id: item.id };
    },
    async notify(id, admission, signal) {
      await ctx.session.synthetic({ sessionID: sessionID(id), ...admission, delivery: "queue", resume: false }, { signal });
    },
    events: signal => ctx.event.subscribe({ signal }),
  };
}

function glob(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
}
export function executionPolicy(session: NativeSession, agent: NativeAgent | undefined, allowAgents: readonly string[]): boolean {
  if (!agent || session.parentID || session.fork || !allowAgents.includes(agent.id)
    || /^(plan|explore|title|summary|compaction)$/i.test(agent.id) || agent.mode === "subagent") return false;
  const rules = [...agent.permissions, ...session.permissions];
  return !["edit", "shell", "bash", "write", "patch"].some(action => {
    let effect: Rule["effect"] | undefined;
    for (const rule of rules) if ((rule.resource === "*" || rule.resource === "**") && glob(rule.action, action)) effect = rule.effect;
    return effect === "deny";
  });
}
