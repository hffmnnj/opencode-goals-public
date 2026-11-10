import type { Plugin } from "@opencode/plugin";
import { POLICY, PublicResultSchema, ToolSchemas, type Operation } from "./contracts.ts";
import type { GoalRuntime } from "./runtime.ts";

const descriptions: Record<Operation, string> = {
  get: "Inspect the full current goal, current content revision, diagnostics and bounded archive summaries. With autoContinue enabled, healthy observations may schedule safe recovery of internal holds; this grants no new authorization.",
  create: "Create a useful substantial-task goal agent-first. Does not grant work permissions or wake the session.",
  revise: "Revise objective/criteria using the current goal ID and content revision. Verified scope is preserved.",
  plan: "Replace (default) or append to the structured plan without removing completed steps or evidence. Required defaults to true.",
  evidence: "Record real, reported verification evidence for one acceptance criterion. The plugin does not independently verify claims.",
  checkpoint: "Record progress, real verification evidence and next step. Restatements are not progress.",
  complete: "Complete only after ALL acceptance criteria have reported evidence and all required work is complete.",
  block: "Record a concrete blocker and stop automatic continuation. Does not authorize bypassing the blocker.",
  pause: "Idempotently pause this exact goal and attempt withdrawal of its owned pending input. Already delivered work may finish.",
  cancel: "Idempotently cancel this exact goal without interrupting unrelated user work. Reservations are not refunded.",
  resume: "Explicitly resume a held goal. recover:true REQUESTS same-server reconciliation, not a trusted bypass. During active or background work it returns scheduled/waiting diagnostics without waiting on this tool's own turn; the runtime rechecks later, so do not poll or ask a human to repeat it. Restricted agents and genuine safety holds cannot be bypassed.",
  history: "Read bounded lifecycle history and archive summaries without waking the model.",
};
export async function registerTools(ctx: Plugin.Context, runtime: GoalRuntime): Promise<void> {
  await ctx.tool.transform(editor => {
    editor.namespace({ name: "goals", description: "Agent-first durable goal bookkeeping; never authority to expand the user's task or approve work." });
    for (const operation of Object.keys(ToolSchemas) as Operation[]) {
      editor.add({
        name: operation, description: descriptions[operation] + " " + POLICY,
        input: ToolSchemas[operation], output: PublicResultSchema,
        options: { namespace: "goals", codemode: true },
        async execute(input, context) {
          const result = await runtime.call(operation, context.sessionID, input, { kind: "agent", agent: context.agent, signal: context.signal });
          return { output: result, content: JSON.stringify(result) };
        },
      });
    }
  });
}
