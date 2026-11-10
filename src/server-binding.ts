import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { SUPPORTED_OPENCODE_VERSION } from "./compatibility.ts";
import { LoopbackURLSchema, type RuntimeOptions } from "./options.ts";

const ServiceRegistrationSchema = z.object({
  id: z.string().uuid(), version: z.string().min(1).max(32), url: LoopbackURLSchema,
  pid: z.number().int().positive(), password: z.string().min(1).max(512),
}).strict();
const ServiceRegistrationPIDSchema = z.object({ pid: z.number().int().positive() }).passthrough();

export interface ManagedServiceRegistration {
  readonly path: string;
  readonly url: string;
  readonly pid: number;
  readonly password: string;
}

export interface ServerBinding {
  readonly baseURL: string;
  /** `legacy` reserves the pre-isolation storage and owner paths for the configured server. */
  readonly identity: string;
  readonly username: string;
  readonly password: string;
}

export interface ServerBindingDependencies {
  readonly listeners?: () => readonly string[] | undefined;
  readonly managedService?: (stateHome: string, pid: number) => ManagedServiceRegistration | undefined;
}

export class ServerBindingError extends Error {
  constructor() {
    super("Unable to identify this OpenCode server safely");
    this.name = "ServerBindingError";
  }
}

function normalizeURL(value: string): string {
  const parsed = LoopbackURLSchema.safeParse(value);
  if (!parsed.success) throw new ServerBindingError();
  return new URL(parsed.data).origin;
}

function secureDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new ServerBindingError();
}

/** Read only the OpenCode service registration owned by this user; never returns a foreign PID. */
export function readManagedServiceRegistration(stateHome: string, pid: number): ManagedServiceRegistration | undefined {
  if (!isAbsolute(stateHome)) throw new ServerBindingError();
  const state = resolve(stateHome);
  const directory = join(state, "opencode");
  const path = join(directory, "service.json");
  try { secureDirectory(state); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new ServerBindingError();
  }
  try { secureDirectory(directory); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new ServerBindingError();
  }

  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new ServerBindingError();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096)
      throw new ServerBindingError();
    const pathStat = lstatSync(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino)
      throw new ServerBindingError();
    const actualPath = realpathSync(path);
    if (actualPath !== path || dirname(actualPath) !== directory) throw new ServerBindingError();
    const content = readFileSync(fd, "utf8");
    if (Buffer.byteLength(content, "utf8") > 4096) throw new ServerBindingError();
    const raw: unknown = JSON.parse(content);
    const pidOnly = ServiceRegistrationPIDSchema.safeParse(raw);
    if (!pidOnly.success) throw new ServerBindingError();
    if (pidOnly.data.pid !== pid) return undefined;
    const parsed = ServiceRegistrationSchema.safeParse(raw);
    if (!parsed.success) throw new ServerBindingError();
    if (parsed.data.version !== SUPPORTED_OPENCODE_VERSION) throw new ServerBindingError();
    return { path: actualPath, url: normalizeURL(parsed.data.url), pid: parsed.data.pid, password: parsed.data.password };
  } catch (error) {
    if (error instanceof ServerBindingError) throw error;
    throw new ServerBindingError();
  } finally { closeSync(fd); }
}

function procTable(contents: string, family: "tcp" | "tcp6"): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of contents.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const [address, rawPort] = (fields[1] ?? "").split(":");
    const inode = fields[9];
    if (!address || !rawPort || !inode || !/^[0-9]+$/.test(inode)) continue;
    const loopback = family === "tcp" ? address.toUpperCase() === "0100007F" : address.toUpperCase() === "00000000000000000000000001000000";
    if (!loopback || !/^[0-9A-Fa-f]{1,4}$/.test(rawPort)) continue;
    const port = Number.parseInt(rawPort, 16);
    if (port < 1 || port > 65535) continue;
    result.set(inode, family === "tcp" ? `http://127.0.0.1:${port}` : `http://[::1]:${port}`);
  }
  return result;
}

/** Discover only literal-loopback listening sockets held by this process, never scan other ports. */
export function discoverCurrentProcessLoopbackListeners(procRoot = "/proc/self"): readonly string[] | undefined {
  try {
    const descriptors = readdirSync(join(procRoot, "fd"));
    const sockets = new Set<string>();
    for (const descriptor of descriptors) {
      try {
        const target = readlinkSync(join(procRoot, "fd", descriptor));
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) sockets.add(match[1]);
      } catch { /* Descriptors can close while the table is read. */ }
    }
    const listeners = new Map<string, string>([
      ...procTable(readFileSync(join(procRoot, "net/tcp"), "utf8"), "tcp"),
      ...procTable(readFileSync(join(procRoot, "net/tcp6"), "utf8"), "tcp6"),
    ]);
    return [...new Set([...sockets].flatMap(inode => listeners.has(inode) ? [listeners.get(inode)!] : []))].sort();
  } catch { return undefined; }
}

function defaultStateHome(env: Readonly<Record<string, string | undefined>>): string {
  return env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
}

function endpointIdentity(url: string): string {
  return `endpoint-v1:${createHash("sha256").update(url).digest("hex")}`;
}

function managedIdentity(path: string): string {
  return `service-v1:${createHash("sha256").update(path).digest("hex")}`;
}

function managedService(
  env: Readonly<Record<string, string | undefined>>,
  pid: number,
  dependencies: ServerBindingDependencies,
): ManagedServiceRegistration | undefined {
  const stateHome = defaultStateHome(env);
  let registration: ManagedServiceRegistration | undefined;
  try { registration = (dependencies.managedService ?? readManagedServiceRegistration)(stateHome, pid); }
  catch { throw new ServerBindingError(); }
  if (registration && registration.pid !== pid) throw new ServerBindingError();
  return registration;
}

function ownedListeners(dependencies: ServerBindingDependencies): string[] {
  const discovered = dependencies.listeners ? dependencies.listeners() : discoverCurrentProcessLoopbackListeners();
  if (!discovered) throw new ServerBindingError();
  try { return [...new Set(discovered.map(normalizeURL))].sort(); }
  catch { throw new ServerBindingError(); }
}

function verifyManagedListener(service: ManagedServiceRegistration, dependencies: ServerBindingDependencies): string {
  const serviceURL = normalizeURL(service.url);
  if (!ownedListeners(dependencies).includes(serviceURL)) throw new ServerBindingError();
  return serviceURL;
}

/** Namespace-only mode for bookkeeping-only configurations; never grants bridge credentials. */
export function resolveServerNamespace(
  api: NonNullable<RuntimeOptions["api"]> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pid = process.pid,
  dependencies: ServerBindingDependencies = {},
): string {
  if (api) return resolveServerBinding(api, env, pid, dependencies).identity;
  const service = managedService(env, pid, dependencies);
  if (service) {
    verifyManagedListener(service, dependencies);
    return managedIdentity(service.path);
  }
  const candidates = ownedListeners(dependencies);
  if (candidates.length !== 1) throw new ServerBindingError();
  return endpointIdentity(candidates[0]);
}

export function resolveServerBinding(
  api: NonNullable<RuntimeOptions["api"]>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pid = process.pid,
  dependencies: ServerBindingDependencies = {},
): ServerBinding {
  const configuredURL = api.baseURL === undefined ? undefined : normalizeURL(api.baseURL);
  const service = managedService(env, pid, dependencies);
  if (service) {
    const serviceURL = verifyManagedListener(service, dependencies);
    return {
      baseURL: serviceURL, identity: managedIdentity(service.path),
      username: env[api.usernameEnv] ?? "", password: service.password,
    };
  }

  const candidates = ownedListeners(dependencies);
  let baseURL: string;
  if (configuredURL && candidates.includes(configuredURL)) baseURL = configuredURL;
  else if (candidates.length === 1) baseURL = candidates[0];
  else throw new ServerBindingError();

  return {
    baseURL,
    identity: baseURL === configuredURL ? "legacy" : endpointIdentity(baseURL),
    username: env[api.usernameEnv] ?? "",
    password: env[api.passwordEnv] ?? "",
  };
}
