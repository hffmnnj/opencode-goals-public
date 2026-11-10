import { Rpc } from "@opencode/plugin/rpc";
import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { PublicResultSchema, RPCSchemas, type Operation } from "./contracts.ts";
import type { GoalRuntime } from "./runtime.ts";

/** Portable client contract. All input/output schemas and events are explicit for 2.0.25. */
export const GoalsRPC = Rpc.define({
  id: "goals",
  methods: {
    get: { input: RPCSchemas.get, output: PublicResultSchema },
    create: { input: RPCSchemas.create, output: PublicResultSchema },
    revise: { input: RPCSchemas.revise, output: PublicResultSchema },
    plan: { input: RPCSchemas.plan, output: PublicResultSchema },
    evidence: { input: RPCSchemas.evidence, output: PublicResultSchema },
    checkpoint: { input: RPCSchemas.checkpoint, output: PublicResultSchema },
    complete: { input: RPCSchemas.complete, output: PublicResultSchema },
    block: { input: RPCSchemas.block, output: PublicResultSchema },
    pause: { input: RPCSchemas.pause, output: PublicResultSchema },
    cancel: { input: RPCSchemas.cancel, output: PublicResultSchema },
    resume: { input: RPCSchemas.resume, output: PublicResultSchema },
    history: { input: RPCSchemas.history, output: PublicResultSchema },
  },
  events: {},
});

export async function registerRPC(ctx: Plugin.Context, runtime: GoalRuntime): Promise<void> {
  function handler<K extends Operation>(operation: K) {
    return async (input: z.output<(typeof RPCSchemas)[K]>, context: { signal: AbortSignal }) => {
      const { sessionID, ...data } = input;
      return runtime.call(operation, sessionID, data, { kind: "agent", signal: context.signal });
    };
  }
  await ctx.rpc.register(GoalsRPC, {
    get: handler("get"), create: handler("create"), revise: handler("revise"), plan: handler("plan"),
    evidence: handler("evidence"), checkpoint: handler("checkpoint"), complete: handler("complete"),
    block: handler("block"), pause: handler("pause"), cancel: handler("cancel"), resume: handler("resume"), history: handler("history"),
  });
}
