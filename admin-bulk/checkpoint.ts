import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export class CheckpointMismatchError extends Error {
  constructor(path: string) {
    super(`checkpoint ${path} belongs to a different spec; delete it to start over`);
    this.name = "CheckpointMismatchError";
  }
}

interface CheckpointFile {
  version: 1;
  specHash: string;
  completed: string[];
  updatedAt: string;
}

export function loadCheckpoint(path: string | undefined, hash: string): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CheckpointFile;
  if (parsed.version !== 1 || parsed.specHash !== hash) throw new CheckpointMismatchError(path);
  return new Set(parsed.completed);
}

/** Write to a temp file and rename, so a crash mid-write never leaves a half-written checkpoint. */
export function saveCheckpoint(path: string, hash: string, completed: ReadonlySet<string>, at: Date): void {
  const body: CheckpointFile = {
    version: 1,
    specHash: hash,
    completed: [...completed].sort(),
    updatedAt: at.toISOString(),
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearCheckpoint(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}
