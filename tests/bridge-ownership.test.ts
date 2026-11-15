import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LoopbackBridge, USER_AGENT } from "../src/bridge.ts";
import { RuntimeOptionsSchema } from "../src/options.ts";
import { acquireOwner } from "../src/ownership.ts";

const api = { baseURL: "http://127.0.0.1:4108", usernameEnv: "TEST_USER", passwordEnv: "TEST_PASSWORD" };
const credentials = { TEST_USER: "fixture-user", TEST_PASSWORD: "fixture-password-not-a-real-secret" };
const ownConfiguredListener = { listeners: () => [api.baseURL], managedService: () => undefined };
// Child processes must resolve the real ownership module regardless of the checkout location.
const ownershipModuleURL = new URL("../src/ownership.ts", import.meta.url).href;
function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(input instanceof Request ? input.url : input), init ?? {})) as typeof fetch;
}
function defaultResponse(url: URL): Response {
  if (url.pathname === "/api/info") return Response.json({ pid: 42, version: "2.0.32", urls: [], paths: { tmp: "/test" } });
  if (url.pathname === "/api/session/active") return Response.json({ data: {} });
  if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/form")) return Response.json({ data: [] });
  return new Response(null, { status: 404 });
}

describe("same-server bridge", () => {
  test("background inventory includes pending children beyond a full first page", async () => {
    const location = { directory: "/project" };
    const cursors: (string | null)[] = [];
    const bridge = new LoopbackBridge(api, transport(url => {
      if (url.pathname === "/api/shell") return Response.json({ location, data: [] });
      if (url.pathname === "/api/session") {
        expect(url.searchParams.get("parentID")).toBe("ses_one");
        expect(url.searchParams.get("limit")).toBe("129");
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        if (cursor === null) return Response.json({ data: Array.from({ length: 129 }, (_, i) => ({
          id: `ses_done${i}`, parentID: "ses_one", location, outcome: "succeeded",
        })), cursor: { next: "opaque-next-page" } });
        expect(cursor).toBe("opaque-next-page");
        return Response.json({ data: [
          { id: "ses_starting", parentID: "ses_one", location },
          { id: "ses_active", parentID: "ses_one", location, outcome: "succeeded" },
          { id: "ses_finished", parentID: "ses_one", location, outcome: "failed" },
        ], cursor: { next: "final-boundary" } });
      }
      if (url.pathname === "/api/session/active") return Response.json({ data: { ses_active: { type: "running" } } });
      return defaultResponse(url);
    }), credentials, 42, ownConfiguredListener);
    expect(await bridge.background("ses_one", location)).toEqual({ shells: [], children: ["ses_starting", "ses_active"] });
    expect(cursors).toEqual([null, "opaque-next-page"]);
  });

  for (const fault of ["ancestry", "duplicate", "cycle", "missing-cursor", "capacity"] as const) {
    test(`paginated background inventory fails closed on later-page ${fault}`, async () => {
      const location = { directory: "/project" };
      let pages = 0;
      const bridge = new LoopbackBridge(api, transport(url => {
        if (url.pathname === "/api/shell") return Response.json({ location, data: [] });
        if (url.pathname === "/api/session") {
          const page = pages++;
          const full = page === 0 || fault === "cycle" || fault === "missing-cursor" || fault === "capacity";
          return Response.json({
            data: Array.from({ length: full ? 129 : 1 }, (_, i) => ({
              id: page > 0 && fault === "duplicate" ? "ses_child0_0" : `ses_child${page}_${i}`,
              parentID: page > 0 && fault === "ancestry" ? "ses_foreign" : "ses_one",
              location,
              outcome: "succeeded",
            })),
            cursor: { next: page > 0 && fault === "missing-cursor" ? null : fault === "cycle" ? "repeated" : `page-${page + 1}` },
          });
        }
        return defaultResponse(url);
      }), credentials, 42, ownConfiguredListener);
      await expect(bridge.background("ses_one", location)).rejects.toMatchObject({ code: "shape" });
      expect(pages).toBe(fault === "capacity" ? 32 : 2);
    });
  }

  test("background inventory retains cross-directory children by ancestry and liveness", async () => {
    const location = { directory: "/project" };
    const bridge = new LoopbackBridge(api, transport(url => {
      if (url.pathname === "/api/shell") return Response.json({ location, data: [] });
      if (url.pathname === "/api/session") {
        return Response.json({ data: [
          { id: "ses_same", parentID: "ses_one", location },
          { id: "ses_other_dir", parentID: "ses_one", location: { directory: "/other" } },
          { id: "ses_other_workspace", parentID: "ses_one", location: { directory: "/project", workspaceID: "ws-other" } },
          { id: "ses_starting_foreign", parentID: "ses_one", location: { directory: "/foreign" } },
          { id: "ses_done_foreign", parentID: "ses_one", location: { directory: "/foreign" }, outcome: "succeeded" },
        ], cursor: {} });
      }
      if (url.pathname === "/api/session/active") return Response.json({ data: {
        ses_same: { type: "running" }, ses_other_dir: { type: "running" }, ses_other_workspace: { type: "running" },
      } });
      return defaultResponse(url);
    }), credentials, 42, ownConfiguredListener);
    expect(await bridge.background("ses_one", location)).toEqual({
      shells: [],
      children: ["ses_same", "ses_other_dir", "ses_other_workspace", "ses_starting_foreign"],
    });
  });

  test("background inventory retains cross-directory children on a later page", async () => {
    const location = { directory: "/project" };
    const bridge = new LoopbackBridge(api, transport(url => {
      if (url.pathname === "/api/shell") return Response.json({ location, data: [] });
      if (url.pathname === "/api/session") {
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) return Response.json({ data: Array.from({ length: 129 }, (_, i) => ({
          id: `ses_done${i}`, parentID: "ses_one", location, outcome: "succeeded",
        })), cursor: { next: "opaque-next-page" } });
        expect(cursor).toBe("opaque-next-page");
        return Response.json({ data: [
          { id: "ses_foreign_starting", parentID: "ses_one", location: { directory: "/foreign" } },
          { id: "ses_foreign_done", parentID: "ses_one", location: { directory: "/foreign" }, outcome: "failed" },
        ], cursor: {} });
      }
      if (url.pathname === "/api/session/active") return Response.json({ data: {} });
      return defaultResponse(url);
    }), credentials, 42, ownConfiguredListener);
    expect(await bridge.background("ses_one", location)).toEqual({ shells: [], children: ["ses_foreign_starting"] });
  });

  test("background inventory fails closed on malformed child location", async () => {
    const location = { directory: "/project" };
    const bridge = new LoopbackBridge(api, transport(url => {
      if (url.pathname === "/api/shell") return Response.json({ location, data: [] });
      if (url.pathname === "/api/session") return Response.json({
        data: [{ id: "ses_child", parentID: "ses_one", location: { workspaceID: "ws-only" } }],
        cursor: {},
      });
      return defaultResponse(url);
    }), credentials, 42, ownConfiguredListener);
    await expect(bridge.background("ses_one", location)).rejects.toMatchObject({ code: "shape" });
  });

  test("native background inventory correlates shell ownership and child ancestry, not global activity", async () => {
    const location = { directory: "/project" };
    const children = [
      { id: "ses_running_child", parentID: "ses_one", location, outcome: "succeeded" },
      { id: "ses_starting_child", parentID: "ses_one", location },
      { id: "ses_done_child", parentID: "ses_one", location, outcome: "succeeded" },
    ];
    const bridge = new LoopbackBridge(api, transport(url => {
      if (url.pathname === "/api/shell") {
        expect(url.searchParams.get("location[directory]")).toBe("/project");
        return Response.json({ location, data: [
          { id: "sh_owned", status: "running", metadata: { sessionID: "ses_one" } },
          { id: "sh_foreign", status: "running", metadata: { sessionID: "ses_other" } },
          { id: "sh_done", status: "exited", metadata: { sessionID: "ses_one" } },
        ] });
      }
      if (url.pathname === "/api/session") {
        expect(url.searchParams.get("parentID")).toBe("ses_one");
        return Response.json({ data: children, cursor: { next: "native-boundary-not-proof-of-another-page" } });
      }
      if (url.pathname === "/api/session/active") return Response.json({ data: { ses_running_child: { type: "running" }, ses_random: { type: "running" } } });
      return defaultResponse(url);
    }), credentials, 42, ownConfiguredListener);
    expect(await bridge.background("ses_one", location)).toEqual({ shells: ["sh_owned"], children: ["ses_running_child", "ses_starting_child"] });
  });

  for (const fault of ["missing", "location", "ancestry", "cursor", "capacity"] as const) {
    test(`background inventory fails closed on ${fault} safety state`, async () => {
      const location = { directory: "/project" };
      const bridge = new LoopbackBridge(api, transport(url => {
        if (url.pathname === "/api/shell") return Response.json({ location: fault === "location" ? { directory: "/foreign" } : location, data: [] });
        if (url.pathname === "/api/session") return Response.json({
          data: fault === "missing" ? undefined : fault === "ancestry" ? [{ id: "ses_child", parentID: "ses_other", location }] : fault === "capacity" ? Array.from({ length: 129 }, (_, i) => ({ id: `ses_child${i}`, parentID: "ses_one", location })) : [],
          cursor: fault === "cursor" ? undefined : {},
        });
        return defaultResponse(url);
      }), credentials, 42, ownConfiguredListener);
      await expect(bridge.background("ses_one", location)).rejects.toMatchObject({ code: "shape" });
    });
  }

  test("strict options reject remote, ambiguous, credentialed or non-root endpoints", () => {
    for (const baseURL of ["http://localhost:4108", "http://127.1:4108", "http://0x7f000001:4108", "http://127.0.0.1:4108/api", "http://127.0.0.1:4108/?x=1", "http://user:password@127.0.0.1:4108", "http://127.0.0.1:99999", "http://127.0.0.1:4108/#fragment", "https://example.com"]) {
      expect(RuntimeOptionsSchema.safeParse({ api: { baseURL } }).success).toBe(false);
    }
    expect(RuntimeOptionsSchema.safeParse({ api: { baseURL: "http://[::1]:4108/" } }).success).toBe(true);
    expect(RuntimeOptionsSchema.parse({ api: {} }).api).toMatchObject({ usernameEnv: "OPENCODE_SERVER_USERNAME", passwordEnv: "OPENCODE_SERVER_PASSWORD" });
    expect(RuntimeOptionsSchema.safeParse({ autoContinue: false, surprising: true }).success).toBe(false);
    expect(RuntimeOptionsSchema.parse({}).autoContinue).toBe(false);
  });

  test("each guarded cycle verifies PID/version, uses required UA and existing credential environment", async () => {
    const requests: { path: string; headers: Headers; redirect?: RequestRedirect }[] = [];
    const bridge = new LoopbackBridge(api, transport((url, init) => {
      requests.push({ path: url.pathname, headers: new Headers(init.headers), redirect: init.redirect });
      return defaultResponse(url);
    }), credentials, 42, ownConfiguredListener);
    expect(await bridge.inspect("ses_one")).toEqual({ active: false, inbox: [], forms: [] });
    await bridge.inspect("ses_one");
    expect(requests.filter(r => r.path === "/api/info")).toHaveLength(2);
    expect(requests.every(r => r.headers.get("user-agent") === USER_AGENT && r.headers.get("authorization")?.startsWith("Basic ") && r.redirect === "error")).toBe(true);
    const auth = requests[0].headers.get("authorization")!.slice(6);
    expect(Buffer.from(auth, "base64").toString()).toBe(`${credentials.TEST_USER}:${credentials.TEST_PASSWORD}`);
  });

  test("managedServiceIdentity_bindsBridgeToItsOwnURLAndCredentialWithoutUsingGlobalPort", async () => {
    const requests: { url: string; auth: string | null }[] = [];
    const servicePassword = "service-registration-password-not-a-real-secret";
    const bridge = new LoopbackBridge(api, transport((url, init) => {
      requests.push({ url: url.href, auth: new Headers(init.headers).get("authorization") });
      return defaultResponse(url);
    }), credentials, 42, {
      managedService: () => ({
        path: "/trusted/state/opencode/service.json", url: "http://127.0.0.1:49374", pid: 42, password: servicePassword,
      }),
      listeners: () => ["http://127.0.0.1:49374"],
    });

    await bridge.verify();

    expect(requests).toEqual([{
      url: "http://127.0.0.1:49374/api/info",
      auth: `Basic ${Buffer.from(`${credentials.TEST_USER}:${servicePassword}`).toString("base64")}`,
    }]);
    expect(bridge.serverIdentity()).toMatch(/^service-v1:[a-f0-9]{64}$/);
  });

  test("unownedConfiguredEndpoint_isRejectedBeforeAnyCredentialsAreSent", async () => {
    let requests = 0;
    const bridge = new LoopbackBridge(api, transport(() => {
      requests++;
      return Response.json({ pid: 99, version: "2.0.32" });
    }), credentials, 42, { managedService: () => undefined, listeners: () => [] });

    await expect(bridge.verify()).rejects.toMatchObject({ code: "binding" });
    expect(requests).toBe(0);
  });

  test("listenerOwnershipIsRecheckedBeforeLaterCredentialBearingRequests", async () => {
    let listenerChecks = 0;
    let requests = 0;
    const bridge = new LoopbackBridge(api, transport(url => {
      requests++;
      return defaultResponse(url);
    }), credentials, 42, {
      managedService: () => undefined,
      listeners: () => ++listenerChecks === 1 ? [api.baseURL] : [],
    });

    await bridge.verify();
    expect(requests).toBe(1);
    await expect(bridge.inspect("ses_one")).rejects.toMatchObject({ code: "binding" });
    expect(requests).toBe(1);
  });

  test("wrong process stops before privileged session reads", async () => {
    const paths: string[] = [];
    const bridge = new LoopbackBridge(api, transport(url => { paths.push(url.pathname); return Response.json({ pid: 43, version: "2.0.32" }); }), credentials, 42, ownConfiguredListener);
    await expect(bridge.inspect("ses_one")).rejects.toMatchObject({ code: "identity" });
    expect(paths).toEqual(["/api/info"]);
  });

  test("only explicitly supported exact versions are accepted before privileged session reads", async () => {
    for (const version of ["2.0.25", "2.0.26", "2.0.31", "2.0.33", "2.2.0", "2.2.2", "2.0.32-rc.1", "2.0.32+build", "2.2.1-rc.1", "2.2.1+build", "v2.0.32", "v2.2.1", "2.0.32 ", "2.2.1 ", "2.2", "2.0", "latest", ""]) {
      const paths: string[] = [];
      const bridge = new LoopbackBridge(api, transport(url => { paths.push(url.pathname); return Response.json({ pid: 42, version }); }), credentials, 42, ownConfiguredListener);
      await expect(bridge.inspect("ses_one")).rejects.toMatchObject({ code: "version" });
      expect(paths).toEqual(["/api/info"]);
    }
    for (const version of ["2.0.32", "2.2.1"]) {
      const verified = new LoopbackBridge(api, transport(url => url.pathname === "/api/info" ? Response.json({ pid: 42, version }) : defaultResponse(url)), credentials, 42, ownConfiguredListener);
      expect(await verified.inspect("ses_one")).toEqual({ active: false, inbox: [], forms: [] });
    }
  });

  test("missing credentials, malformed reads and HTTP errors have no unsafe fallback or secret diagnostics", async () => {
    let calls = 0;
    const absent = new LoopbackBridge(api, transport(() => { calls++; throw new Error("must not call"); }), {}, 42, ownConfiguredListener);
    await expect(absent.inspect("ses_one")).rejects.toMatchObject({ code: "credentials" });
    expect(calls).toBe(0);
    const broken = new LoopbackBridge(api, transport(() => { throw new Error(credentials.TEST_PASSWORD); }), credentials, 42, ownConfiguredListener);
    const failure = await broken.verify().then(() => null, error => error as Error);
    expect(String(failure)).not.toContain(credentials.TEST_PASSWORD);
    expect(String(failure)).not.toContain(credentials.TEST_USER);
    expect(failure).toMatchObject({ code: "transport" });
    const malformed = new LoopbackBridge(api, transport(url => url.pathname.endsWith("/inbox") ? Response.json({ data: "not an array" }) : defaultResponse(url)), credentials, 42, ownConfiguredListener);
    await expect(malformed.inspect("ses_one")).rejects.toMatchObject({ code: "shape" });
    const unauthorized = new LoopbackBridge(api, transport(() => new Response("sensitive response body", { status: 401 })), credentials, 42, ownConfiguredListener);
    const rejected = await unauthorized.verify().then(() => null, error => error as Error);
    expect(rejected).toMatchObject({ code: "http" });
    expect(String(rejected)).not.toContain("sensitive response body");
  });

  test("inbox/form session identity mismatches are rejected and cancellation targets one explicit ID", async () => {
    const paths: { path: string; method?: string }[] = [];
    const bridge = new LoopbackBridge(api, transport((url, init) => {
      paths.push({ path: url.pathname, method: init.method });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/form")) return Response.json({ data: [{ id: "frm_wrong", sessionID: "ses_other" }] });
      return defaultResponse(url);
       }), credentials, 42, ownConfiguredListener);
    await expect(bridge.inspect("ses_one")).rejects.toMatchObject({ code: "shape" });
    await bridge.cancel("ses_one", "msg_owned");
    expect(paths.filter(r => r.method === "DELETE")).toEqual([{ path: "/api/session/ses_one/inbox/msg_owned", method: "DELETE" }]);
  });

  test("default agent resolution exposes only an unambiguous configured name, never raw config", async () => {
    let conflict = false;
    const bridge = new LoopbackBridge(api, transport(url => url.pathname === "/api/config"
      ? Response.json([{ type: "directory", path: "/p" }, { type: "document", info: { default_agent: "build", privateCredentials: "must-never-return" } }, ...(conflict ? [{ type: "document", info: { default_agent: "plan" } }] : [])])
      : defaultResponse(url)), credentials, 42, ownConfiguredListener);
    expect(await bridge.defaultAgent(undefined, "/project")).toBe("build");
    conflict = true;
    await expect(bridge.defaultAgent(undefined, "/project")).rejects.toMatchObject({ code: "shape" });
  });
});

describe("real filesystem cooperative ownership", () => {
  async function paths() {
    const state = await mkdtemp(join(tmpdir(), "goals-owner-test-"));
    const directory = join(state, "opencode-goals", "owners");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, `${createHash("sha256").update(JSON.stringify(["/project", ""])).digest("hex")}.lock`);
    return { state, directory, lock };
  }
  async function deadPID() {
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    return child.pid;
  }

  test("live owner blocks another runtime and release removes only matching token", async () => {
    const p = await paths(); const owner = await acquireOwner("/project", "", p.state);
    // Same-process reload hands off: second acquire reclaims, first loses ownership.
    const next = await acquireOwner("/project", "", p.state);
    await expect(owner.assertOwned()).rejects.toMatchObject({ code: "ownership_lost" });
    await next.assertOwned();
    const replacement = { pid: process.pid, token: randomUUID() };
    await writeFile(p.lock, JSON.stringify(replacement));
    await expect(next.assertOwned()).rejects.toMatchObject({ code: "ownership_lost" });
    await next.release();
    expect(JSON.parse(await readFile(p.lock, "utf8"))).toEqual(replacement);
    await owner.release();
  });

  test("live owner in another process still blocks acquisition", async () => {
    const p = await paths();
    const holder = Bun.spawn([process.execPath, "-e", `
      import { acquireOwner } from ${JSON.stringify(ownershipModuleURL)};
      const owner = await acquireOwner("/project", "", ${JSON.stringify(p.state)});
      await new Promise(() => {});
    `], { stdout: "ignore", stderr: "ignore" });
    try {
      // Wait for the child to claim the lock.
      for (let i = 0; i < 50; i++) {
        try {
          await Bun.file(p.lock).text();
          break;
        } catch { await new Promise(r => setTimeout(r, 50)); }
      }
      await expect(acquireOwner("/project", "", p.state)).rejects.toMatchObject({ code: "live_owner" });
    } finally {
      holder.kill();
      await holder.exited;
    }
    // Dead owner is reclaimable.
    const owner = await acquireOwner("/project", "", p.state);
    try { await owner.assertOwned(); }
    finally { await owner.release(); }
  });

  test("serverNamespaces_allowIndependentOwnersWithoutChangingTheLegacyLock", async () => {
    const p = await paths();
    const legacy = await acquireOwner("/project", "", p.state);
    const service = await acquireOwner("/project", "", p.state, "service-v1:service-a");
    const other = await acquireOwner("/project", "", p.state, "endpoint-v1:server-b");
    try {
      // Same-process handoff for the same namespace succeeds; the previous
      // instance loses ownership. Different namespaces stay independent.
      const legacyNext = await acquireOwner("/project", "", p.state);
      await expect(legacy.assertOwned()).rejects.toMatchObject({ code: "ownership_lost" });
      await legacyNext.assertOwned();
      const serviceNext = await acquireOwner("/project", "", p.state, "service-v1:service-a");
      await expect(service.assertOwned()).rejects.toMatchObject({ code: "ownership_lost" });
      await serviceNext.assertOwned();
      await other.assertOwned();
      const locks = (await readdir(p.directory)).filter(name => name.endsWith(".lock")).sort();
      expect(locks).toHaveLength(3);
      expect(locks).toContain(`${createHash("sha256").update(JSON.stringify(["/project", ""])).digest("hex")}.lock`);
      await legacyNext.release();
      await serviceNext.release();
    } finally {
      await legacy.release();
      await service.release();
      await other.release();
    }
    expect(await readdir(p.directory)).toEqual([]);
  });

  test("concurrent stale-owner reclamation has exactly one winner and never deletes its live lock", async () => {
    const p = await paths();
    await writeFile(p.lock, JSON.stringify({ pid: await deadPID(), token: randomUUID() }), { mode: 0o600 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireOwner("/project", "", p.state)));
    const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireOwner>>> => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const owner = winners[0].value;
    try {
      await owner.assertOwned();
      expect(JSON.parse(await readFile(p.lock, "utf8"))).toEqual({ pid: process.pid, token: owner.token });
      // Same-process handoff succeeds; the previous winner loses ownership.
      const next = await acquireOwner("/project", "", p.state);
      await expect(owner.assertOwned()).rejects.toMatchObject({ code: "ownership_lost" });
      await next.assertOwned();
      await next.release();
    } finally { await owner.release(); }
    expect(await readdir(p.directory)).toEqual([]);
  });

  test("an ambiguous/stale reclamation guard is retained and diagnosed, never auto-deleted", async () => {
    const p = await paths(); const old = { pid: await deadPID(), token: randomUUID() };
    await writeFile(p.lock, JSON.stringify(old));
    await writeFile(`${p.lock}.reclaim`, JSON.stringify(old));
    await expect(acquireOwner("/project", "", p.state)).rejects.toMatchObject({ code: "reclamation_guard" });
    expect(JSON.parse(await readFile(`${p.lock}.reclaim`, "utf8"))).toEqual(old);
    expect(JSON.parse(await readFile(p.lock, "utf8"))).toEqual(old);
  });
});
