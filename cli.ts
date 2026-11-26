import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, parse, resolve } from "node:path";
import { experimental_hostToolchain } from "@get-bb/plugin-sdk/process";
import { experimental_buildProviderCliEnv, experimental_compareVersions, experimental_versionFrom, type ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";

export const BB_ANTIGRAVITY_GEMINI_DIR_ENV = "BB_ANTIGRAVITY_GEMINI_DIR";
export const BB_ANTIGRAVITY_APP_DATA_DIR_ENV = "BB_ANTIGRAVITY_APP_DATA_DIR";
export const DEFAULT_ANTIGRAVITY_GEMINI_DIR = ".gemini";
export const DEFAULT_ANTIGRAVITY_APP_DATA_DIR = "antigravity-cli";

export type AntigravityProfileOverrides = {
  geminiDir: string | null;
  appDataDir: string | null;
};

const GEMINI_DIR_FLAGS = ["--gemini-dir", "--gemini_dir"] as const;
const APP_DATA_DIR_FLAGS = ["--app-data-dir", "--app_data_dir"] as const;

function isFullyQualified(path: string | undefined): path is string {
  // Windows considers paths rooted on the current drive absolute as well.
  return path !== undefined && isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length > 1);
}

function windowsEnvKey(env: NodeJS.ProcessEnv, name: string): string {
  return Object.keys(env).find(key => key.toUpperCase() === name) ?? name;
}

export function hostHomeDirectory(): string | undefined {
  try {
    const home = homedir();
    return isFullyQualified(home) ? home : undefined;
  } catch {
    return undefined;
  }
}

function installerPath(env: NodeJS.ProcessEnv): string | null {
  const windows = process.platform === "win32";
  if (windows) {
    const localAppData = env[windowsEnvKey(env, "LOCALAPPDATA")];
    if (isFullyQualified(localAppData)) return join(localAppData, "agy", "bin", "agy.exe");
  }
  const home = hostHomeDirectory();
  if (home === undefined) return null;
  return windows ? join(home, "AppData", "Local", "agy", "bin", "agy.exe") : join(home, ".local", "bin", "agy");
}

const MIN_AGY_ACP_VERSION = "1.5.0";

export function addAntigravityHealthDiagnostic(result: ProviderHealthResult | undefined): void {
  if (result?.supported !== true || result.health?.status !== "ready") return;
  const health = result.health;
  const version = health.installedVersion;
  if (typeof version !== "string" || experimental_versionFrom(version) !== version ||
      experimental_compareVersions(version, MIN_AGY_ACP_VERSION) >= 0) return;

  health.status = "unsupported_version";
  health.minimumSupportedVersion = MIN_AGY_ACP_VERSION;
  health.statusMessage = `Antigravity CLI ${version} is installed on the agent host. BB needs version ${MIN_AGY_ACP_VERSION} or later for ACP. Run \`agy update\` on that host, then check provider health again.`;
}

export function resolveAntigravityCommand(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string | null {
  if (command !== "agy") return experimental_hostToolchain.resolve(command, options);
  let env = options?.env ?? process.env;
  const homeKey = process.platform === "win32" ? windowsEnvKey(env, "USERPROFILE") : "HOME";
  if (!isFullyQualified(env[homeKey])) {
    // An empty value prevents the SDK from rediscovering home or expanding a bare drive.
    const home = env[homeKey] === undefined ? hostHomeDirectory() : undefined;
    env = { ...env, [homeKey]: home ?? "" };
  }
  const hostPath = experimental_hostToolchain.environment(env).PATH ?? "";
  // Windows bare-name lookup starts in cwd. Search the host PATH explicitly.
  for (const entry of hostPath.split(delimiter)) {
    const directory = process.platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!isFullyQualified(directory)) continue;
    const found = experimental_hostToolchain.resolve(join(directory, command), { env });
    if (found) return found;
  }
  const candidate = installerPath(env);
  if (candidate === null) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function nonEmptyEnvValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readEnvOverride(
  hostEnv: Readonly<Record<string, unknown>>,
  sessionEnvVars: unknown,
  key: string,
): string | null {
  if (isPlainRecord(sessionEnvVars) && Object.hasOwn(sessionEnvVars, key)) {
    return nonEmptyEnvValue(sessionEnvVars[key]);
  }
  return nonEmptyEnvValue(hostEnv[key]);
}

export function readAntigravityProfileOverrides(
  hostEnv: Readonly<Record<string, unknown>>,
  sessionEnvVars?: unknown,
): AntigravityProfileOverrides {
  return {
    geminiDir: readEnvOverride(hostEnv, sessionEnvVars, BB_ANTIGRAVITY_GEMINI_DIR_ENV),
    appDataDir: readEnvOverride(hostEnv, sessionEnvVars, BB_ANTIGRAVITY_APP_DATA_DIR_ENV),
  };
}

function hasFlag(args: readonly unknown[], names: readonly string[]): boolean {
  return args.some(arg => {
    if (typeof arg !== "string") return false;
    return names.some(name => arg === name || arg.startsWith(`${name}=`));
  });
}

function readFlagValue(args: readonly unknown[] | undefined, names: readonly string[]): { present: boolean; value: string | null } {
  if (!Array.isArray(args)) return { present: false, value: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    for (const name of names) {
      if (arg === name) {
        return { present: true, value: nonEmptyEnvValue(args[i + 1]) };
      }
      if (arg.startsWith(`${name}=`)) {
        return { present: true, value: nonEmptyEnvValue(arg.slice(name.length + 1)) };
      }
    }
  }
  return { present: false, value: null };
}

export function extractAntigravityProfileFromLaunchSpec(
  spec: { args?: readonly unknown[] } | null | undefined,
  hostEnv: Readonly<Record<string, unknown>>,
  sessionEnvVars?: unknown,
): AntigravityProfileOverrides {
  const envOverrides = readAntigravityProfileOverrides(hostEnv, sessionEnvVars);
  const geminiFlag = readFlagValue(spec?.args, GEMINI_DIR_FLAGS);
  const appDataFlag = readFlagValue(spec?.args, APP_DATA_DIR_FLAGS);
  return {
    geminiDir: geminiFlag.present ? geminiFlag.value : envOverrides.geminiDir,
    appDataDir: appDataFlag.present ? appDataFlag.value : envOverrides.appDataDir,
  };
}

export function resolveAntigravityProfilePaths(
  profile: AntigravityProfileOverrides,
  hostEnv: NodeJS.ProcessEnv,
): { geminiDir: string; appDataDir: string; effectiveAppDataDir: string } {
  const homeKey = process.platform === "win32" ? windowsEnvKey(hostEnv, "USERPROFILE") : "HOME";
  const envHome = hostEnv[homeKey] ?? (process.platform === "win32" ? hostEnv[windowsEnvKey(hostEnv, "HOME")] : undefined);
  const baseHome = (isFullyQualified(envHome) ? envHome : undefined) ?? hostHomeDirectory() ?? "";
  const geminiDir = profile.geminiDir !== null
    ? resolve(baseHome, profile.geminiDir)
    : join(baseHome, DEFAULT_ANTIGRAVITY_GEMINI_DIR);
  const effectiveAppDataDir = profile.appDataDir ?? DEFAULT_ANTIGRAVITY_APP_DATA_DIR;
  const appDataDir = resolve(geminiDir, effectiveAppDataDir);
  return { geminiDir, appDataDir, effectiveAppDataDir };
}

function applyProfileFlags(spec: Record<string, any>, overrides: AntigravityProfileOverrides): void {
  if (!Array.isArray(spec.args) || spec.args[0] !== "acp") return;
  const extraArgs: string[] = [];
  if (overrides.geminiDir !== null && !hasFlag(spec.args, GEMINI_DIR_FLAGS)) {
    extraArgs.push("--gemini-dir", overrides.geminiDir);
  }
  if (overrides.appDataDir !== null && !hasFlag(spec.args, APP_DATA_DIR_FLAGS)) {
    extraArgs.push("--app-data-dir", overrides.appDataDir);
  }
  if (extraArgs.length > 0) {
    spec.args = [...spec.args, ...extraArgs];
  }
}

// Resolve on the agent host, where the CLI is installed, rather than the BB server.
export function resolveAntigravityLaunchSpec(request: any): boolean {
  const params = request?.params;
  const targets = [
    { options: params?.providerOptions, envVars: params?.envVars },
    { options: params?.options?.providerOptions, envVars: params?.options?.envVars },
  ];
  for (const { options, envVars } of targets) {
    const spec = options?.acpLaunchSpec;
    if (!spec || typeof spec !== "object") continue;
    const env = experimental_buildProviderCliEnv(spec.env);
    if (spec.command === "agy") {
      // An unresolved bare command would let the ACP bridge retry in the workspace and session PATH.
      const command = resolveAntigravityCommand("agy", { env }) ?? installerPath(env);
      if (command === null) return false;
      spec.command = command;
    }
    applyProfileFlags(spec, readAntigravityProfileOverrides(env, envVars));
  }
  return true;
}
