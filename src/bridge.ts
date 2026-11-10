import { z } from "zod";
import { SUPPORTED_OPENCODE_VERSION } from "./compatibility.ts";
import type { RuntimeOptions } from "./options.ts";
import { LoopbackURLSchema } from "./options.ts";
import { resolveServerBinding, type ServerBinding, type ServerBindingDependencies } from "./server-binding.ts";

export const USER_AGENT = "opencode-goals/1.0";
export type BridgeFailure = "missing_config" | "credentials" | "binding" | "identity" | "version" | "http" | "shape" | "transport";
export class BridgeError extends Error {
  constructor(readonly code: BridgeFailure) { super(`Same-server bridge unavailable: ${code}`); this.name = "BridgeError"; }
}
const InfoSchema = z.object({ version: z.string(), pid: z.number().int().positive() });
const MetadataSchema = z.record(z.string(), z.unknown());
const InboxSchema = z.object({
  id: z.string().startsWith("msg_"), sessionID: z.string().startsWith("ses"),
  type: z.enum(["user", "synthetic", "compaction", "move"]),
  time: z.object({ created: z.number().finite() }),
  payload: z.object({ metadata: MetadataSchema.optional() }).passthrough(),
  delivery: z.enum(["queue", "steer"]),
});
export type InboxItem = z.infer<typeof InboxSchema>;
export interface BridgeSnapshot { active: boolean; inbox: InboxItem[]; forms: { id: string; sessionID: string }[] }
export interface BackgroundSnapshot { shells: string[]; children: string[] }
/** Owned boundary; implementations must verify the same server on each inspection/withdrawal. */
export interface ServerBridge {
  verify(signal?: AbortSignal): Promise<void>;
  serverIdentity(): string;
  inspect(sessionID: string, signal?: AbortSignal): Promise<BridgeSnapshot>;
  background(sessionID: string, location: { directory: string; workspaceID?: string }, signal?: AbortSignal): Promise<BackgroundSnapshot>;
  cancel(sessionID: string, ownedId: string, signal?: AbortSignal): Promise<void>;
  defaultAgent(signal?: AbortSignal, directory?: string): Promise<string | undefined>;
}
export class LoopbackBridge implements ServerBridge {
  private binding?: ServerBinding;
  private verified = false;
  constructor(
    private readonly api: RuntimeOptions["api"],
    private readonly fetcher: typeof fetch = fetch,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly pid = process.pid,
    private readonly bindingDependencies?: ServerBindingDependencies,
  ) { if (api?.baseURL && !LoopbackURLSchema.safeParse(api.baseURL).success) throw new BridgeError("missing_config"); }
  private resolveBinding(): ServerBinding {
    if (this.binding) return this.binding;
    if (!this.api) throw new BridgeError("missing_config");
    try { this.binding = resolveServerBinding(this.api, this.env, this.pid, this.bindingDependencies); }
    catch { throw new BridgeError("binding"); }
    return this.binding;
  }
  private currentBinding(): ServerBinding {
    if (!this.binding) return this.resolveBinding();
    const original = this.binding;
    if (!this.api) throw new BridgeError("missing_config");
    let current: ServerBinding;
    try { current = resolveServerBinding(this.api, this.env, this.pid, this.bindingDependencies); }
    catch { throw new BridgeError("binding"); }
    if (current.baseURL !== original.baseURL || current.identity !== original.identity)
      throw new BridgeError("binding");
    return current;
  }
  private async request(path: string, schema: z.ZodType | null, signal?: AbortSignal, method = "GET"): Promise<unknown> {
    const binding = this.currentBinding();
    const username = binding.username; const password = binding.password;
    if (!username || !password || username.includes(":")) throw new BridgeError("credentials");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, binding.baseURL), {
        method, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        headers: { "User-Agent": USER_AGENT, Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
      });
    } catch { throw new BridgeError("transport"); }
    if (!response.ok || !schema && response.status !== 204) throw new BridgeError("http");
    if (!schema) return null;
    try {
      const result = schema.safeParse(await response.json());
      if (!result.success) throw new BridgeError("shape");
      return result.data;
    } catch { throw new BridgeError("shape"); }
  }
  async verify(signal?: AbortSignal): Promise<void> {
    this.verified = false;
    const info = InfoSchema.parse(await this.request("/api/info", InfoSchema, signal));
    if (info.pid !== this.pid) throw new BridgeError("identity");
    // Deliberately pin the verified patch contract; widen only after another compatibility audit.
    if (info.version !== SUPPORTED_OPENCODE_VERSION) throw new BridgeError("version");
    this.verified = true;
  }
  serverIdentity(): string {
    if (!this.verified || !this.binding) throw new BridgeError("identity");
    return this.binding.identity;
  }
  async inspect(sessionID: string, signal?: AbortSignal): Promise<BridgeSnapshot> {
    await this.verify(signal);
    const activeSchema = z.object({ data: z.record(z.string().startsWith("ses"), z.object({ type: z.literal("running") })) });
    const inboxSchema = z.object({ data: z.array(InboxSchema).max(1000) });
    const formsSchema = z.object({ data: z.array(z.object({ id: z.string().startsWith("frm_"), sessionID: z.string() })).max(1000) });
    const path = `/api/session/${encodeURIComponent(sessionID)}`;
    const [active, inbox, forms] = await Promise.all([
      this.request("/api/session/active", activeSchema, signal),
      this.request(`${path}/inbox`, inboxSchema, signal),
      this.request(`${path}/form`, formsSchema, signal),
    ]);
    const entries = inboxSchema.parse(inbox).data; const pendingForms = formsSchema.parse(forms).data;
    if (entries.some(item => item.sessionID !== sessionID) || pendingForms.some(form => form.sessionID !== sessionID)) throw new BridgeError("shape");
    return { active: sessionID in activeSchema.parse(active).data, inbox: entries, forms: pendingForms };
  }
  async cancel(sessionID: string, ownedId: string, signal?: AbortSignal): Promise<void> {
    await this.verify(signal);
    await this.request(`/api/session/${encodeURIComponent(sessionID)}/inbox/${encodeURIComponent(ownedId)}`, null, signal, "DELETE");
  }
  async background(sessionID: string, location: { directory: string; workspaceID?: string }, signal?: AbortSignal): Promise<BackgroundSnapshot> {
    await this.verify(signal);
    const locationSchema = z.object({ directory: z.string(), workspaceID: z.string().optional() });
    const shellsSchema = z.object({ location: locationSchema, data: z.array(z.object({
      id: z.string().min(1), status: z.enum(["running", "exited", "timeout", "killed"]),
      metadata: z.object({ sessionID: z.string().startsWith("ses").optional() }),
    })).max(1000) });
    const childrenSchema = z.object({ data: z.array(z.object({
      id: z.string().startsWith("ses"), parentID: z.string().startsWith("ses"), location: locationSchema,
      outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
    })).max(129), cursor: z.object({ next: z.string().min(1).nullable().optional() }) });
    const activeSchema = z.object({ data: z.record(z.string().startsWith("ses"), z.object({ type: z.literal("running") })) });
    const query = new URLSearchParams({ "location[directory]": location.directory });
    const sameLocation = (value: z.infer<typeof locationSchema>) => value.directory === location.directory && value.workspaceID === location.workspaceID;
    const listChildren = async () => {
      const children: z.infer<typeof childrenSchema>["data"] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      const params = new URLSearchParams({ parentID: sessionID, limit: "129" });
      // Bound total work without treating a partial inventory as proof of idle.
      for (let page = 0; page < 32; page++) {
        const result = childrenSchema.parse(await this.request(`/api/session?${params}`, childrenSchema, signal));
        for (const child of result.data) {
          // Child locations legitimately vary across directories; ancestry and liveness decide.
          if (child.parentID !== sessionID || ids.has(child.id)) throw new BridgeError("shape");
          ids.add(child.id);
          children.push(child);
        }
        // Native cursors can exist on a final page. Only a short page proves
        // coverage; a full page requires another validated, non-repeating page.
        if (result.data.length < 129) return children;
        const next = result.cursor.next;
        if (!next || cursors.has(next)) throw new BridgeError("shape");
        cursors.add(next);
        params.set("cursor", next);
      }
      throw new BridgeError("shape");
    };
    const [shellRaw, children, activeRaw] = await Promise.all([
      this.request(`/api/shell?${query}`, shellsSchema, signal),
      listChildren(),
      this.request("/api/session/active", activeSchema, signal),
    ]);
    const shells = shellsSchema.parse(shellRaw);
    if (!sameLocation(shells.location)) throw new BridgeError("shape");
    const active = activeSchema.parse(activeRaw).data;
    return {
      shells: shells.data.filter(shell => shell.metadata.sessionID === sessionID && shell.status === "running").map(shell => shell.id),
      // A newly created child may not have started its loop yet. Absence from
      // active is not completion: require its native terminal outcome as well.
      children: children.filter(child => child.id in active || child.outcome === undefined).map(child => child.id),
    };
  }
  async defaultAgent(signal?: AbortSignal, directory?: string): Promise<string | undefined> {
    await this.verify(signal);
    // Parse just this field. Never retain or return the full configuration.
    const schema = z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("document"), info: z.object({ default_agent: z.string().min(1).optional() }) }),
      z.object({ type: z.literal("directory"), path: z.string() }),
    ])).max(1000);
    const path = `/api/config${directory ? `?location[directory]=${encodeURIComponent(directory)}` : ""}`;
    const entries = schema.parse(await this.request(path, schema, signal));
    const agents = new Set(entries.flatMap(entry => entry.type === "document" && entry.info.default_agent ? [entry.info.default_agent] : []));
    // Do not guess precedence from a document inventory with conflicting defaults.
    if (agents.size > 1) throw new BridgeError("shape");
    return agents.size === 1 ? [...agents][0] : undefined;
  }
}
