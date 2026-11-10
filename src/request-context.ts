import { Message, type SystemPart } from "@opencode/ai";
import { POLICY } from "./contracts.ts";

/**
 * Shared cross-plugin brand for transient request tails. Other plugins inspect
 * the latest user message, so every generated tail carries this non-enumerable
 * in-process marker. Context-Clef ignores any tail bearing this symbol when
 * finding the authored query and historical scope.
 */
export const TRANSIENT_CONTEXT = Symbol.for("opencode.transient-context.v1");
export const TRANSIENT_OWNER = "goals";

/** Split the combined context() string into its fixed system prefix and changing tail. */
export function splitPolicyContext(combined: string): { policy: string; suffix: string } {
  if (combined === "") return { policy: "", suffix: "" };
  if (combined.startsWith(`${POLICY}\n`)) return { policy: POLICY, suffix: combined.slice(POLICY.length + 1) };
  return { policy: combined, suffix: "" };
}

/** True only for this plugin's own transient tail. Never matches user text or other plugins' tails. */
export function isOwnTransient(message: unknown): boolean {
  return typeof message === "object" && message !== null
    && (message as Record<symbol, unknown>)[TRANSIENT_CONTEXT] === TRANSIENT_OWNER;
}

/** Brand a generated tail without touching its serialized form. The symbol is absent from JSON. */
export function brandTransient<T extends Message>(message: T): T {
  Object.defineProperty(message, TRANSIENT_CONTEXT, {
    value: TRANSIENT_OWNER, enumerable: false, writable: false, configurable: true,
  });
  return message;
}

/** Fresh branded native user message carrying quoted goal task data. No message IDs are invented. */
export function transientGoalMessage(text: string): Message {
  return brandTransient(Message.user(text));
}

export interface RequestShape {
  system: readonly SystemPart[];
  messages: readonly Message[];
}

/**
 * Pure request placement: fixed POLICY stays the only system addition, the
 * changing suffix becomes a branded tail user message. Returns new arrays and
 * never mutates the inputs, previous messages, or tool/result adjacency. Only
 * this plugin's own branded transient is ever removed or replaced.
 */
export function applyGoalRequestContext(event: RequestShape, combined: string): { system: SystemPart[]; messages: Message[] } {
  const { policy, suffix } = splitPolicyContext(combined);
  const messages = event.messages.filter(message => !isOwnTransient(message));
  if (policy === "") return { system: [...event.system], messages };
  // Dedupe this plugin's own policy by brand as well as by exact canonical
  // text, so a JSON round-trip (which drops the private symbol) stays idempotent.
  // Only the exact canonical POLICY string matches; substrings and other text survive.
  const system = event.system.filter(part => (part as unknown as Record<symbol, unknown>)[TRANSIENT_CONTEXT] !== "goals-policy"
    && !(part.type === "text" && part.text === POLICY));
  const policyPart: SystemPart = { type: "text", text: policy };
  Object.defineProperty(policyPart, TRANSIENT_CONTEXT, { value: "goals-policy" });
  system.push(policyPart);
  if (suffix !== "") messages.push(transientGoalMessage(suffix));
  return { system, messages };
}
