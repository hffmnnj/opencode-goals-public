import type { Plugin } from "@opencode/plugin";
import type { ServerBridge } from "./bridge.ts";
import { nativeHost } from "./native.ts";
import type { RuntimeOptions } from "./options.ts";
import { acquireOwner, createStandbyOwner } from "./ownership.ts";
import { GoalRuntime } from "./runtime.ts";
import { resolveServerNamespace, type ServerBindingDependencies } from "./server-binding.ts";

/** Owned startup boundary; stateHome, like acquireOwner's argument, is trusted. */
export async function createGoalRuntime(
  ctx: Plugin.Context, options: RuntimeOptions, bridge: ServerBridge, stateHome?: string,
  bindingDependencies?: ServerBindingDependencies,
): Promise<GoalRuntime> {
  // Establish the loading server's stable namespace before any owner or state I/O.
  let namespace: string | undefined;
  if (options.api) {
    await bridge.verify();
    const identity = bridge.serverIdentity();
    if (identity !== "legacy") namespace = identity;
  } else {
    const identity = resolveServerNamespace(undefined, process.env, process.pid, bindingDependencies);
    namespace = identity;
  }
  const owner = await acquireOwner(ctx.location.directory, ctx.location.workspaceID, stateHome, namespace);
  try {
    return new GoalRuntime({ host: nativeHost(ctx), storage: ctx.storage, owner, bridge, options, namespace });
  } catch (error) {
    await owner.release();
    throw error;
  }
}

/**
 * Degraded startup that never claims a filesystem lock and never verifies the
 * bridge. The plugin still loads (tools/RPC/commands available for
 * bookkeeping) with automation disabled: observation stays disabled in setup,
 * so no scheduling occurs and bridge failures only mark diagnostics.
 * Storage uses the verified bridge identity when available, otherwise a
 * safely resolved configured identity, then a best-effort process-scoped
 * namespace, otherwise legacy sharing.
 */
export function createDegradedGoalRuntime(
  ctx: Plugin.Context, options: RuntimeOptions, bridge: ServerBridge,
  bindingDependencies?: ServerBindingDependencies,
): GoalRuntime {
  let namespace: string | undefined;
  try {
    const identity = bridge.serverIdentity();
    if (identity !== "legacy") namespace = identity;
  } catch {
    try {
      const identity = resolveServerNamespace(options.api, process.env, process.pid, bindingDependencies);
      if (identity !== "legacy") namespace = identity;
    } catch {
      try {
        namespace = resolveServerNamespace(undefined, process.env, process.pid, bindingDependencies);
      } catch {
        namespace = undefined;
      }
    }
  }
  const owner = createStandbyOwner();
  return new GoalRuntime({ host: nativeHost(ctx), storage: ctx.storage, owner, bridge, options, namespace });
}
