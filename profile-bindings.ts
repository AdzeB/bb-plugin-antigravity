import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostHomeDirectory, resolveAntigravityProfilePaths, type AntigravityProfileOverrides } from "./cli.ts";

export const ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE =
  "Cannot resume Antigravity session on a different profile. Restore the original BB_ANTIGRAVITY_GEMINI_DIR / BB_ANTIGRAVITY_APP_DATA_DIR profile or start a new thread.";

const MAX_PERSISTED_BINDINGS = 2_000;

export interface SessionProfileBinding {
  threadId: string;
  providerThreadId: string;
  profileHash: string;
  updatedAt: number;
}

interface PersistedSessionProfileState {
  version: 1;
  bindings: SessionProfileBinding[];
}

export function defaultProfileBindingsPath(): string | undefined {
  const override = process.env.BB_ANTIGRAVITY_TASK_STATE_DIR?.trim();
  if (override) return join(override, "session-profiles.json");
  const home = hostHomeDirectory();
  return home === undefined ? undefined : join(home, ".bb", "plugin-data", "bb-plugin-antigravity", "session-profiles.json");
}

export function hashAntigravityProfile(
  profile: AntigravityProfileOverrides,
  hostEnv: NodeJS.ProcessEnv,
): string {
  const { appDataDir } = resolveAntigravityProfilePaths(profile, hostEnv);
  const normalized = process.platform === "win32" ? appDataDir.toLowerCase() : appDataDir;
  return createHash("sha256").update(normalized).digest("hex");
}

function isValidBinding(value: unknown): value is SessionProfileBinding {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.threadId === "string" &&
    record.threadId.length > 0 &&
    typeof record.providerThreadId === "string" &&
    record.providerThreadId.length > 0 &&
    typeof record.profileHash === "string" &&
    record.profileHash.length > 0 &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt)
  );
}

function boundBindings(bindings: SessionProfileBinding[]): SessionProfileBinding[] {
  return bindings
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PERSISTED_BINDINGS);
}

function readBindingsFile(persistPath: string): SessionProfileBinding[] {
  try {
    const raw = readFileSync(persistPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSessionProfileState> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.bindings)) return [];
    return parsed.bindings.filter(isValidBinding);
  } catch {
    return [];
  }
}

function writeBindingsFile(persistPath: string, bindings: SessionProfileBinding[]): void {
  const payload = JSON.stringify({
    version: 1,
    bindings: boundBindings(bindings),
  } satisfies PersistedSessionProfileState);
  mkdirSync(dirname(persistPath), { recursive: true });
  const tempPath = `${persistPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, payload, { mode: 0o600 });
    renameSync(tempPath, persistPath);
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch {}
    try { writeFileSync(persistPath, payload, { mode: 0o600 }); } catch {
      throw error;
    }
  }
}

export interface SessionProfileStore {
  bind(entry: { threadId: string; providerThreadId: string; profileHash: string }): void;
  find(ref: { threadId?: string; providerThreadId?: string }): SessionProfileBinding | null;
  checkMismatch(ref: { threadId?: string; providerThreadId?: string; profileHash: string }): boolean;
  forget(ref: { threadId?: string; providerThreadId?: string }): void;
}

export function createSessionProfileStore(options?: {
  persistPath?: string;
  now?: () => number;
}): SessionProfileStore {
  const persistPath = options && "persistPath" in options ? options.persistPath : defaultProfileBindingsPath();
  const now = options?.now ?? (() => Date.now());
  let memoryBindings: SessionProfileBinding[] = [];

  const readAll = (): SessionProfileBinding[] =>
    persistPath === undefined ? memoryBindings : readBindingsFile(persistPath);

  const writeAll = (bindings: SessionProfileBinding[]): void => {
    if (persistPath === undefined) {
      memoryBindings = boundBindings(bindings);
      return;
    }
    try {
      writeBindingsFile(persistPath, bindings);
    } catch {}
  };

  const find = (ref: { threadId?: string; providerThreadId?: string }): SessionProfileBinding | null => {
    const bindings = readAll();
    if (ref.providerThreadId) {
      const bySession = bindings.find(entry => entry.providerThreadId === ref.providerThreadId);
      if (bySession) return bySession;
    }
    if (ref.threadId) {
      const byThread = bindings.find(entry => entry.threadId === ref.threadId);
      if (byThread) return byThread;
    }
    return null;
  };

  return {
    bind(entry) {
      const bindings = readAll().filter(
        existing =>
          existing.providerThreadId !== entry.providerThreadId &&
          existing.threadId !== entry.threadId,
      );
      bindings.push({
        threadId: entry.threadId,
        providerThreadId: entry.providerThreadId,
        profileHash: entry.profileHash,
        updatedAt: now(),
      });
      writeAll(bindings);
    },
    find,
    checkMismatch(ref) {
      const existing = find(ref);
      return existing !== null && existing.profileHash !== ref.profileHash;
    },
    forget(ref) {
      const bindings = readAll();
      const next = bindings.filter(
        existing =>
          (ref.providerThreadId ? existing.providerThreadId !== ref.providerThreadId : true) &&
          (ref.threadId ? existing.threadId !== ref.threadId : true),
      );
      if (next.length === bindings.length) return;
      writeAll(next);
    },
  };
}
