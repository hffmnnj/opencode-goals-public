// Exact audited host versions only; the SDK remains pinned independently.
const SUPPORTED_OPENCODE_VERSIONS: ReadonlySet<string> = new Set(["2.0.32", "2.2.1"]);

export function isSupportedOpenCodeVersion(version: string): boolean {
  return SUPPORTED_OPENCODE_VERSIONS.has(version);
}
