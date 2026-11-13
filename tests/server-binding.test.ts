import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCurrentProcessLoopbackListeners,
  readManagedServiceRegistration,
  resolveServerNamespace,
  resolveServerBinding,
  ServerBindingError,
} from "../src/server-binding.ts";

const api = {
  baseURL: "http://127.0.0.1:4108",
  usernameEnv: "GOALS_BINDING_USER",
  passwordEnv: "GOALS_BINDING_PASSWORD",
} as const;
const fixtureUser = "fixture-user";
const fixtureEnvPassword = "fixture-env-password-not-a-secret";
function bindingEnv(): Record<string, string | undefined> {
  return {
    GOALS_BINDING_USER: fixtureUser,
    GOALS_BINDING_PASSWORD: fixtureEnvPassword,
    XDG_STATE_HOME: join(tmpdir(), "goals-binding-unused"),
  };
}
const fixtureServicePath = join(tmpdir(), "goals-binding-state", "opencode", "service.json");

describe("proc fixture discovery", () => {
  test("discovery_joinsOnlyOwnedLoopbackListenSockets", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "goals-binding-proc-"));
    try {
      await mkdir(join(procRoot, "fd"), { recursive: true });
      await mkdir(join(procRoot, "net"), { recursive: true });
      // Owned socket FDs. 55555 is deliberately absent (foreign inode).
      await symlink("socket:[11111]", join(procRoot, "fd", "10"));
      await symlink("socket:[22222]", join(procRoot, "fd", "11"));
      await symlink("socket:[33333]", join(procRoot, "fd", "12"));
      await symlink("socket:[44444]", join(procRoot, "fd", "13"));
      await symlink("socket:[66666]", join(procRoot, "fd", "14"));
      await symlink("pipe:[12345]", join(procRoot, "fd", "15"));
      const header =
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
      await writeFile(
        join(procRoot, "net", "tcp"),
        [
          header,
          // 0FA0 = 4000: owned IPv4 loopback LISTEN, the only wanted IPv4 row.
          "   0: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0",
          // 0FA1 = 4001: owned but wildcard LISTEN, must be ignored.
          "   1: 00000000:0FA1 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 100 0 0 10 0",
          // 0FA2 = 4002: owned loopback but ESTABLISHED (01), must be ignored.
          "   2: 0100007F:0FA2 0100007F:0FA2 01 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0",
          // 0FA3 = 4003: valid loopback LISTEN but foreign inode (no FD), must be ignored.
          "   3: 0100007F:0FA3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0000000000000000 100 0 0 10 0",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(procRoot, "net", "tcp6"),
        [
          header,
          // 0FA4 = 4004: owned IPv6 loopback LISTEN, the only wanted IPv6 row.
          "   0: 00000000000000000000000001000000:0FA4 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0",
          // 0FA5 = 4005: owned but IPv6 wildcard LISTEN, must be ignored.
          "   1: 00000000000000000000000000000000:0FA5 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 66666 1 0000000000000000 100 0 0 10 0",
          "",
        ].join("\n"),
      );

      expect(discoverCurrentProcessLoopbackListeners(procRoot)).toEqual([
        "http://127.0.0.1:4000",
        "http://[::1]:4004",
      ]);
    } finally {
      for (const descriptor of ["10", "11", "12", "13", "14", "15"]) await unlink(join(procRoot, "fd", descriptor)).catch(() => undefined);
      for (const table of ["tcp", "tcp6"]) await unlink(join(procRoot, "net", table)).catch(() => undefined);
      await rmdir(join(procRoot, "fd")).catch(() => undefined);
      await rmdir(join(procRoot, "net")).catch(() => undefined);
      await rmdir(procRoot).catch(() => undefined);
    }
  });
});

describe("managed service binding", () => {
  test("managedService_matchingPidOverridesConfiguredEndpoint", () => {
    const servicePath = fixtureServicePath;
    const service = {
      path: servicePath,
      url: "http://127.0.0.1:4567",
      pid: 424242,
      password: "fixture-service-password-a-not-a-secret",
    };
    const binding = resolveServerBinding(api, bindingEnv(), service.pid, {
      managedService: () => service,
      listeners: () => [service.url],
    });
    expect(binding.baseURL).toBe("http://127.0.0.1:4567");
    expect(binding.password).toBe("fixture-service-password-a-not-a-secret");
    expect(binding.username).toBe(fixtureUser);
    // Independent oracle: identity is specified as sha256(path), not "call the helper".
    expect(binding.identity).toBe(`service-v1:${createHash("sha256").update(servicePath).digest("hex")}`);
    expect(binding.identity).not.toBe("legacy");
  });

  test("managedService_identityStableAcrossPidAndUrlChanges", () => {
    const servicePath = fixtureServicePath;
    const first = resolveServerBinding(api, bindingEnv(), 424242, {
      managedService: () => ({
        path: servicePath,
        url: "http://127.0.0.1:4567",
        pid: 424242,
        password: "fixture-service-password-a-not-a-secret",
      }),
      listeners: () => ["http://127.0.0.1:4567"],
    });
    const second = resolveServerBinding(api, bindingEnv(), 424243, {
      managedService: () => ({
        path: servicePath,
        url: "http://127.0.0.1:4568",
        pid: 424243,
        password: "fixture-service-password-b-not-a-secret",
      }),
      listeners: () => ["http://127.0.0.1:4568"],
    });
    expect(second.identity).toBe(first.identity);
    expect(second.baseURL).toBe("http://127.0.0.1:4568");
    expect(second.baseURL).not.toBe(first.baseURL);
    expect(second.password).not.toBe(first.password);
  });

  test("managedService_foreignPidNeverUsed", () => {
    const foreignPassword = "fixture-foreign-password-not-a-secret";
    let error: unknown;
    try {
      resolveServerBinding(api, bindingEnv(), 424242, {
        managedService: () => ({
          path: fixtureServicePath,
          url: "http://127.0.0.1:4567",
          pid: 999999,
          password: foreignPassword,
        }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServerBindingError);
    expect(String(error)).not.toContain(foreignPassword);
  });
});

describe("discovered listener binding", () => {
  test("discoveryOnlyApiOptionsNeedNoConfiguredPort", () => {
    const binding = resolveServerBinding({
      usernameEnv: api.usernameEnv,
      passwordEnv: api.passwordEnv,
    }, bindingEnv(), 424242, {
      managedService: () => undefined,
      listeners: () => ["http://127.0.0.1:49374"],
    });
    expect(binding.baseURL).toBe("http://127.0.0.1:49374");
    expect(binding.identity).toBe(`endpoint-v1:${createHash("sha256").update(binding.baseURL).digest("hex")}`);
  });

  test("discovery_singleUnconfiguredListenerUsesIsolatedIdentity", () => {
    const discovered = "http://127.0.0.1:4567";
    const binding = resolveServerBinding(api, bindingEnv(), 424242, {
      managedService: () => undefined,
      listeners: () => [discovered],
    });
    expect(binding.baseURL).toBe(discovered);
    // Independent oracle: endpoint identity is specified as sha256(url).
    expect(binding.identity).toBe(`endpoint-v1:${createHash("sha256").update(discovered).digest("hex")}`);
    expect(binding.identity).not.toBe("legacy");
    expect(binding.username).toBe(fixtureUser);
    expect(binding.password).toBe(fixtureEnvPassword);
  });

  test("discovery_configuredListenerKeepsLegacyIdentity", () => {
    const configured = resolveServerBinding(api, bindingEnv(), 424242, {
      managedService: () => undefined,
      listeners: () => ["http://127.0.0.1:4108"],
    });
    expect(configured.baseURL).toBe("http://127.0.0.1:4108");
    expect(configured.identity).toBe("legacy");
    expect(configured.password).toBe(fixtureEnvPassword);

    // The configured endpoint wins even when another owned listener exists.
    const withExtra = resolveServerBinding(api, bindingEnv(), 424242, {
      managedService: () => undefined,
      listeners: () => ["http://127.0.0.1:4567", "http://127.0.0.1:4108"],
    });
    expect(withExtra.baseURL).toBe("http://127.0.0.1:4108");
    expect(withExtra.identity).toBe("legacy");
  });

  test("discovery_ambiguousOwnedListenersFailClosed", () => {
    let error: unknown;
    try {
      resolveServerBinding(api, bindingEnv(), 424242, {
        managedService: () => undefined,
        listeners: () => ["http://127.0.0.1:5001", "http://127.0.0.1:5002"],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServerBindingError);
    expect(String(error)).not.toContain(fixtureEnvPassword);
  });

  test("bookkeepingOnly_instancesStillReceiveProcessScopedNamespaces", () => {
    const namespace = resolveServerNamespace(undefined, bindingEnv(), 424242, {
      managedService: () => undefined,
      listeners: () => ["http://127.0.0.1:49374"],
    });
    expect(namespace).toBe(`endpoint-v1:${createHash("sha256").update("http://127.0.0.1:49374").digest("hex")}`);
  });
});

describe("service registration files", () => {
  async function safeState(password = "fixture-service-password-not-a-secret"): Promise<{
    state: string;
    pid: number;
  }> {
    const state = await mkdtemp(join(tmpdir(), "goals-binding-service-"));
    const directory = join(state, "opencode");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    await chmod(directory, 0o700);
    const pid = process.pid;
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({
        id: randomUUID(),
        version: "2.0.32",
        url: "http://127.0.0.1:4567",
        pid,
        password,
      }),
      { mode: 0o600 },
    );
    await chmod(join(directory, "service.json"), 0o600);
    return { state, pid };
  }

  test("serviceFile_safePrivateFileAcceptedForMatchingPid", async () => {
    const { state, pid } = await safeState();
    try {
      const registration = readManagedServiceRegistration(state, pid);
      expect(registration?.url).toBe("http://127.0.0.1:4567");
      expect(registration?.pid).toBe(pid);
      expect(registration?.password).toBe("fixture-service-password-not-a-secret");
      expect(registration?.path).toBe(join(state, "opencode", "service.json"));
    } finally {
      await unlink(join(state, "opencode", "service.json")).catch(() => undefined);
      await rmdir(join(state, "opencode")).catch(() => undefined);
      await rmdir(state).catch(() => undefined);
    }
  });

  test("serviceFile_onlyExact2032VersionAccepted", async () => {
    for (const version of ["2.0.25", "2.0.26", "2.0.31", "2.0.33", "2.0.32-rc.1", "2.0.32+build", "v2.0.32", "2.0", "latest", ""]) {
      const state = await mkdtemp(join(tmpdir(), "goals-binding-version-"));
      try {
        const directory = join(state, "opencode");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(state, 0o700);
        await chmod(directory, 0o700);
        await writeFile(
          join(directory, "service.json"),
          JSON.stringify({
            id: randomUUID(),
            version,
            url: "http://127.0.0.1:4567",
            pid: process.pid,
            password: "fixture-service-password-not-a-secret",
          }),
          { mode: 0o600 },
        );
        await chmod(join(directory, "service.json"), 0o600);
        expect(() => readManagedServiceRegistration(state, process.pid)).toThrow(ServerBindingError);
      } finally {
        await unlink(join(state, "opencode", "service.json")).catch(() => undefined);
        await rmdir(join(state, "opencode")).catch(() => undefined);
        await rmdir(state).catch(() => undefined);
      }
    }
  });

  test("serviceFile_otherPidIgnored", async () => {
    const { state, pid } = await safeState();
    try {
      expect(readManagedServiceRegistration(state, pid + 1)).toBeUndefined();
    } finally {
      await unlink(join(state, "opencode", "service.json")).catch(() => undefined);
      await rmdir(join(state, "opencode")).catch(() => undefined);
      await rmdir(state).catch(() => undefined);
    }
  });

  test("serviceFile_symlinkRejected", async () => {
    const state = await mkdtemp(join(tmpdir(), "goals-binding-symlink-"));
    try {
      const directory = join(state, "opencode");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(state, 0o700);
      await chmod(directory, 0o700);
      const realPath = join(state, "real.json");
      await writeFile(
        realPath,
        JSON.stringify({
          id: randomUUID(),
          version: "2.0.32",
          url: "http://127.0.0.1:4567",
          pid: process.pid,
          password: "fixture-service-password-not-a-secret",
        }),
        { mode: 0o600 },
      );
      await chmod(realPath, 0o600);
      await symlink(realPath, join(directory, "service.json"));
      expect(() => readManagedServiceRegistration(state, process.pid)).toThrow(ServerBindingError);
    } finally {
      await unlink(join(state, "opencode", "service.json")).catch(() => undefined);
      await unlink(join(state, "real.json")).catch(() => undefined);
      await rmdir(join(state, "opencode")).catch(() => undefined);
      await rmdir(state).catch(() => undefined);
    }
  });

  test("serviceFile_groupReadableRejected", async () => {
    const { state, pid } = await safeState();
    try {
      await chmod(join(state, "opencode", "service.json"), 0o644);
      expect(() => readManagedServiceRegistration(state, pid)).toThrow(ServerBindingError);
    } finally {
      await unlink(join(state, "opencode", "service.json")).catch(() => undefined);
      await rmdir(join(state, "opencode")).catch(() => undefined);
      await rmdir(state).catch(() => undefined);
    }
  });
});
