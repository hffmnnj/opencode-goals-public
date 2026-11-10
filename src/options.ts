import { z } from "zod";
import { ConfigSchema } from "./schema.ts";

export const LoopbackURLSchema = z.string().refine(value => {
  if (!/^https?:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(value)) return false;
  try { const url = new URL(value); return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; }
  catch { return false; }
}, "Expected a literal loopback root URL without credentials");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const RuntimeOptionsSchema = ConfigSchema.extend({
  api: z.object({
    baseURL: LoopbackURLSchema.optional(),
    usernameEnv: envName.default("OPENCODE_SERVER_USERNAME"),
    passwordEnv: envName.default("OPENCODE_SERVER_PASSWORD"),
  }).strict().optional(),
  allowAgents: z.array(z.string().trim().min(1).max(160)).min(1).max(32).default(["build"]),
  contextChars: z.number().int().min(1000).max(16000).default(6000),
}).strict();
export type RuntimeOptions = z.output<typeof RuntimeOptionsSchema>;
export type RuntimeOptionsInput = z.input<typeof RuntimeOptionsSchema>;

export function coreOptions(options: RuntimeOptions) {
  const { api: _api, allowAgents: _agents, contextChars: _chars, ...core } = options;
  return core;
}
