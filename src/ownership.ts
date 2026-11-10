import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, lstat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const LockSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict();
type LockRecord = z.infer<typeof LockSchema>;
export interface RuntimeOwner { readonly token: string; assertOwned(): Promise<void>; release(): Promise<void> }
export class OwnershipError extends Error {
  constructor(readonly code: "live_owner" | "reclamation_guard" | "invalid_owner" | "ownership_lost" | "io" = "invalid_owner") {
    super(code === "reclamation_guard"
      ? "Ownership blocked by an existing reclamation guard; it is never automatically deleted, even if stale"
      : `Exclusive goal runtime ownership unavailable: ${code}; do not delete live owner files`);
    this.name = "OwnershipError";
  }
}
const errno = (error: unknown, code: string) => !!error && typeof error === "object" && "code" in error && error.code === code;

export function createStandbyOwner(): RuntimeOwner {
  const token = randomUUID();
  return {
    token,
    async assertOwned() {},
    async release() {},
  };
}

/** Cooperative OS ownership, not storage CAS. Stale reclamation is serialized separately. */
export async function acquireOwner(
  location: string,
  workspace = "",
  stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
  namespace?: string,
): Promise<RuntimeOwner> {
  if (!isAbsolute(stateHome)) throw new OwnershipError();
  if (namespace !== undefined && (!namespace.trim() || namespace.length > 512)) throw new OwnershipError();
  const directory = join(stateHome, "opencode-goals", "owners");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) throw new OwnershipError();
  const lockIdentity = namespace === undefined ? [location, workspace] : ["servers/v2", namespace, location, workspace];
  const path = join(directory, `${createHash("sha256").update(JSON.stringify(lockIdentity)).digest("hex")}.lock`);
  const record: LockRecord = { pid: process.pid, token: randomUUID() };
  async function read(at: string): Promise<LockRecord> {
    const stat = await lstat(at);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 1000) throw new OwnershipError();
    return LockSchema.parse(JSON.parse(await readFile(at, "utf8")));
  }
  async function create(at: string): Promise<void> {
    const file = await open(at, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
  }
  async function releaseFile(at: string): Promise<void> {
    try { const saved = await read(at); if (saved.token === record.token && saved.pid === record.pid) await unlink(at); }
    catch (error) { if (!errno(error, "ENOENT")) throw new OwnershipError(); }
  }
  try { await create(path); }
  catch (error) {
    if (!errno(error, "EEXIST")) throw new OwnershipError();
    const reclaim = `${path}.reclaim`;
    try { await create(reclaim); } catch (error) { throw new OwnershipError(errno(error, "EEXIST") ? "reclamation_guard" : "io"); }
    try {
      const previous = await read(path);
      if (previous.pid !== record.pid) {
        try { process.kill(previous.pid, 0); throw new OwnershipError("live_owner"); }
        catch (probe) { if (!errno(probe, "ESRCH")) throw new OwnershipError("live_owner"); }
      }
      // Same-process handoff (previous.pid === process.pid): a reloaded plugin
      // instance in this process reclaims the lock; the previous instance loses
      // ownership on its next assertOwned via token mismatch and stops scheduling.
      const checked = await read(path);
      if (checked.token !== previous.token || checked.pid !== previous.pid) throw new OwnershipError();
      await unlink(path); // Only the confirmed dead, unchanged owner; never recursively delete.
      await create(path);
    } catch (error) { throw error instanceof OwnershipError ? error : new OwnershipError("io"); }
    finally { await releaseFile(reclaim); }
  }
  let released = false;
  return {
    token: record.token,
    async assertOwned() {
      if (released) throw new OwnershipError("ownership_lost");
      try { const saved = await read(path); if (saved.token !== record.token || saved.pid !== record.pid) throw new OwnershipError(); }
      catch { throw new OwnershipError("ownership_lost"); }
    },
    async release() { if (!released) { released = true; await releaseFile(path); } },
  };
}
