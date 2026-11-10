import { Plugin } from "@opencode/plugin";
import { BridgeError, LoopbackBridge } from "./bridge.ts";
import { registerCommands } from "./commands.ts";
import { RuntimeOptionsSchema } from "./options.ts";
import { OwnershipError } from "./ownership.ts";
import { applyGoalRequestContext } from "./request-context.ts";
import { registerRPC } from "./rpc.ts";
import type { GoalRuntime } from "./runtime.ts";
import { createDegradedGoalRuntime, createGoalRuntime } from "./startup.ts";
import { registerTools } from "./tools.ts";

/** Sequential command writer supplies this hook; the wiring below passes the live runtime through. */
export type RegisterCommands = (ctx: Plugin.Context, runtime: GoalRuntime) => Promise<void | (() => Promise<void> | void)>;
export function defineGoalsPlugin(registerCommands?: RegisterCommands) {
  return Plugin.define({
    id: "opencode-goals",
    async setup(ctx) {
      const options = RuntimeOptionsSchema.parse(ctx.options);
      const bridge = new LoopbackBridge(options.api);
      let runtime: GoalRuntime;
      let degraded = false;
      try {
        runtime = await createGoalRuntime(ctx, options, bridge);
      } catch (error) {
        if (!(error instanceof BridgeError || error instanceof OwnershipError)) throw error;
        // Operational contention (live owner, transient binding) must not fail
        // plugin load. Degraded bookkeeping stays available with automation
        // disabled; the next activation retries exclusive startup.
        const code = error instanceof BridgeError ? error.code : error.code;
        console.warn(`[opencode-goals] degraded startup: ${code}; automation disabled, bookkeeping available`);
        runtime = createDegradedGoalRuntime(ctx, options, bridge);
        degraded = true;
      }
      let commandsCleanup: (() => Promise<void> | void) | undefined;
      try {
        const active = runtime;
        await ctx.session.hook("context", async event => {
          const applied = applyGoalRequestContext(event, await active.context(event.sessionID, event.agent));
          event.system = applied.system;
          event.messages = applied.messages;
        });
        await ctx.session.hook("compaction", async event => {
          const applied = applyGoalRequestContext(event, await active.context(event.sessionID, event.agent, false));
          event.system = applied.system;
          event.messages = applied.messages;
        });
        await ctx.session.hook("prompt", event => active.guardPrompt(event));
        await registerTools(ctx, active);
        await registerRPC(ctx, active);
        commandsCleanup = (await registerCommands?.(ctx, active)) ?? undefined;
        if (!degraded) active.startObserving();
        return async () => {
          try { await active.dispose(); } finally { await commandsCleanup?.(); }
        };
      } catch (error) {
        await runtime.dispose();
        throw error;
      }
    },
  });
}
export default defineGoalsPlugin((ctx, runtime) => registerCommands(ctx, runtime));
export { GoalRuntime } from "./runtime.ts";
export { GoalsRPC } from "./rpc.ts";
