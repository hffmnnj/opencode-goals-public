import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LoopbackBridge, USER_AGENT } from "../src/bridge.ts";
import { RuntimeOptionsSchema } from "../src/options.ts";
import type { GoalRuntime } from "../src/runtime.ts";
import type { GoalStorage } from "../src/service.ts";
import { createDegradedGoalRuntime, createGoalRuntime } from "../src/startup.ts";

const options = RuntimeOptionsSchema.parse({ api: { baseURL: "http://127.0.0.1:4108", usernameEnv: "FIXTURE_USER", passwordEnv: "FIXTURE_PASSWORD" } });
const credentials = { FIXTURE_USER: "fixture-user", FIXTURE_PASSWORD: "fixture-password-not-a-secret" };
const info = { pid: 42, version: "2.0.32" };
const ownListener = { managedService: () => undefined, listeners: () => ["http://127.0.0.1:4108"] };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(input instanceof Request ? input.url : input), init ?? {})) as typeof fetch;
}
function context(): Plugin.Context {
  const location = { directory: "/startup-fixture/project" };
  const values = new Map<string, Parameters<GoalStorage["set"]>[1]>();
  const storage: GoalStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
  };
  return {
    location, storage,
    session: { get: async ({ sessionID }: { sessionID: string }) => ({
      id: sessionID, location, time: {}, agent: "build", permissions: [],
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }) },
    agent: { get: async () => ({ location, data: { id: "build", mode: "primary", permissions: [] } }) },
  } as unknown as Plugin.Context;
}
async function settle(pending: Promise<GoalRuntime>): Promise<{ runtime?: GoalRuntime; error?: unknown }> {
  return pending.then(runtime => ({ runtime }), error => ({ error }));
}

describe("server-bound runtime startup", () => {
  test("configured identity verification finishes BEFORE any ownership filesystem access", async () => {
    const stateHome = await mkdtemp("/var/tmp/example/opencode/goals-startup-order-");
    const verifying = deferred(); const release = deferred(); let calls = 0;
    const bridge = new LoopbackBridge(options.api, transport(async (url, init) => {
      calls++;
      expect(url.pathname).toBe("/api/info");
      expect(new Headers(init.headers).get("user-agent")).toBe(USER_AGENT);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      verifying.resolve(); await release.promise;
      return Response.json(info);
    }), credentials, info.pid, ownListener);
    const starting = settle(createGoalRuntime(context(), options, bridge, stateHome));
    try {
      // Also completes on the original bug (startup returned without verification),
      // so the regression fails an assertion rather than hanging on an unused gate.
      await Promise.race([verifying.promise, starting]);
      expect(calls).toBe(1);
      expect(await readdir(stateHome)).toEqual([]);
      release.resolve();
      const result = await starting;
      expect(result.error).toBeUndefined();
      expect(await readdir(join(stateHome, "opencode-goals", "owners"))).toHaveLength(1);
    } finally { release.resolve(); await (await starting).runtime?.dispose(); }
    expect(await readdir(join(stateHome, "opencode-goals", "owners"))).toEqual([]);
  });

  test("an unverified competing process cannot claim the valid server location lock", async () => {
    const stateHome = await mkdtemp("/var/tmp/example/opencode/goals-startup-competing-");
    const verifying = deferred(); const release = deferred();
    const wrong = new LoopbackBridge(options.api, transport(async () => {
      verifying.resolve(); await release.promise; return Response.json(info);
    }), credentials, info.pid + 1, ownListener);
    const right = new LoopbackBridge(options.api, transport(() => Response.json(info)), credentials, info.pid, ownListener);
    const wrongStarting = settle(createGoalRuntime(context(), options, wrong, stateHome));
    let rightResult: Awaited<ReturnType<typeof settle>> | undefined;
    try {
      await Promise.race([verifying.promise, wrongStarting]);
      rightResult = await settle(createGoalRuntime(context(), options, right, stateHome));
      expect(rightResult.error).toBeUndefined();
      expect(rightResult.runtime).toBeDefined();
      release.resolve();
      const rejected = await wrongStarting;
      expect(rejected.error).toMatchObject({ code: "identity" });
      // Rejection did not delete/reclaim the valid runtime's lock.
      const result = await rightResult.runtime!.call("create", "ses_startup", {
        objective: "Authorized native bookkeeping", criteria: [{ id: "verified", description: "Observe real acceptance evidence" }],
      }, { kind: "agent", agent: "build" });
      expect(result).toMatchObject({ ok: true, current: { status: "active" } });
      expect(await readdir(join(stateHome, "opencode-goals", "owners"))).toHaveLength(1);
    } finally {
      release.resolve();
      await (await wrongStarting).runtime?.dispose();
      await rightResult?.runtime?.dispose();
    }
  });

  for (const failure of ["credentials", "transport", "http", "shape", "version", "identity"] as const) {
    test(`explicit binding failure (${failure}) fails setup without claiming ownership`, async () => {
      const stateHome = await mkdtemp("/var/tmp/example/opencode/goals-startup-unverified-");
      const bridge = new LoopbackBridge(options.api, transport(() => {
        if (failure === "transport") throw new Error("Fixture transport unavailable");
        if (failure === "http") return new Response(null, { status: 401 });
        if (failure === "shape") return Response.json({ pid: "invalid", version: "2.0.32" });
        return Response.json({ ...info, ...(failure === "version" ? { version: "2.0.31" } : {}), ...(failure === "identity" ? { pid: info.pid + 1 } : {}) });
      }), failure === "credentials" ? {} : credentials, info.pid, ownListener);
      const result = await settle(createGoalRuntime(context(), options, bridge, stateHome));
      try {
        expect(result.error).toMatchObject({ code: failure });
        expect(await readdir(stateHome)).toEqual([]);
        expect(String(result.error)).not.toContain(credentials.FIXTURE_PASSWORD);
      } finally { await result.runtime?.dispose(); }
    });
  }

  test("only exact 2.0.32 version starts without claiming ownership", async () => {
    for (const version of ["2.0.25", "2.0.26", "2.0.31", "2.0.33", "2.0.32-rc.1", "2.0.32+build", "v2.0.32", "2.0", "latest", ""]) {
      const stateHome = await mkdtemp("/var/tmp/example/opencode/goals-startup-version-");
      const bridge = new LoopbackBridge(options.api, transport(() => Response.json({ pid: info.pid, version })), credentials, info.pid, ownListener);
      const result = await settle(createGoalRuntime(context(), options, bridge, stateHome));
      try {
        expect(result.error).toMatchObject({ code: "version" });
        expect(await readdir(stateHome)).toEqual([]);
      } finally { await result.runtime?.dispose(); }
    }
  });

  test("generic no-api startup requires no bridge/auth and supports native bookkeeping", async () => {
    const stateHome = await mkdtemp("/var/tmp/example/opencode/goals-startup-generic-");
    let calls = 0;
    const bridge = new LoopbackBridge(undefined, transport(() => { calls++; throw new Error("No bridge should be used"); }), {});
    const runtime = await createGoalRuntime(context(), RuntimeOptionsSchema.parse({}), bridge, stateHome, {
      managedService: () => undefined, listeners: () => ["http://127.0.0.1:49400"],
    });
    try {
      expect(await runtime.call("create", "ses_generic", {
        objective: "Manage a useful authorized task", criteria: [{ id: "verified", description: "Verify the actual outcome" }],
      }, { kind: "agent", agent: "build" })).toMatchObject({
        ok: true, current: { status: "active" }, diagnostics: { autoContinue: false, bridge: "unchecked" },
      });
      expect(calls).toBe(0);
    } finally { await runtime.dispose(); }
    expect(await readdir(join(stateHome, "opencode-goals", "owners"))).toEqual([]);
  });

  test("degraded startup still loads bookkeeping when binding fails", async () => {
    const bridge = new LoopbackBridge(options.api, transport(() => { throw new Error("Fixture transport unavailable"); }), credentials, info.pid, ownListener);
    const strict = await settle(createGoalRuntime(context(), options, bridge, await mkdtemp("/var/tmp/example/opencode/goals-startup-degraded-")));
    expect(strict.error).toMatchObject({ code: "transport" });
    const degraded = createDegradedGoalRuntime(context(), options, bridge);
    try {
      const result = await degraded.call("create", "ses_degraded", {
        objective: "Degraded bookkeeping remains available", criteria: [{ id: "verified", description: "Verify the actual outcome" }],
      }, { kind: "agent", agent: "build" });
      expect(result.ok).toBe(true);
      expect(degraded.diagnostics()).toMatchObject({ events: "disabled" });
    } finally { await degraded.dispose(); }
  });

  test("degraded startup still loads when another process holds the owner lock", async () => {
    const stateHome = await mkdtemp("/var/tmp/example/opencode/goals-startup-degraded-owner-");
    const holder = Bun.spawn([process.execPath, "-e", `
      import { acquireOwner } from "/home/example/Documents/opencode-goals/src/ownership.ts";
      await acquireOwner("/startup-fixture/project", "", ${JSON.stringify(stateHome)});
      await new Promise(() => {});
    `], { stdout: "ignore", stderr: "ignore" });
    try {
      for (let i = 0; i < 50; i++) {
        try {
          const { readdir } = await import("node:fs/promises");
          const { join } = await import("node:path");
          if ((await readdir(join(stateHome, "opencode-goals", "owners"))).length > 0) break;
        } catch {}
        await new Promise(r => setTimeout(r, 50));
      }
      const goodBridge = new LoopbackBridge(options.api, transport(() => Response.json(info)), credentials, info.pid, ownListener);
      const strict = await settle(createGoalRuntime(context(), options, goodBridge, stateHome));
      // Holder is a different live process, so exclusive startup stays failed.
      expect(strict.error).toMatchObject({ code: "live_owner" });
      const degraded = createDegradedGoalRuntime(context(), options, goodBridge);
      try {
        expect(degraded.diagnostics()).toMatchObject({ events: "disabled" });
      } finally { await degraded.dispose(); }
      await strict.runtime?.dispose();
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
});
