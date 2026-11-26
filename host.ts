import { experimental_acpLaunchSpecSchema, experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import {
  experimental_buildProviderCliEnv,
  threadStartParamsSchema,
  threadResumeParamsSchema,
  turnStartParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderHealthResult, ProviderInstallationStatus } from "@get-bb/plugin-sdk/provider-bridge";
import { createBackgroundTaskTracker, defaultBackgroundTaskStatePath } from "./background-tasks.ts";
import { ANTIGRAVITY_ACP_DIALECT_ID, applyThreadCommandDescriptions, onToolUpdate, registerAntigravityAcpDialect } from "./dialect.ts";
import { modeControlOutput } from "./mode-controls.ts";
import { mapPromptMode } from "./prompt-mode.ts";
import { interceptSubagentApproval, isSubagentApprovalForDisabledThread, transformSubagentRequest } from "./subagents.ts";
import { readAntigravityProviderUsage } from "./usage.ts";
import { extractAntigravityProfileFromLaunchSpec, resolveAntigravityLaunchSpec } from "./cli.ts";
import {
  ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE,
  createSessionProfileStore,
  defaultProfileBindingsPath,
  hashAntigravityProfile,
} from "./profile-bindings.ts";

registerAntigravityAcpDialect();

let rawStdoutWrite: typeof process.stdout.write | null = null;
export const backgroundTaskTracker = createBackgroundTaskTracker({
  persistPath: defaultBackgroundTaskStatePath(),
  onAsyncDeltas(threadId, deltas) {
    if (!deltas.length) return;
    const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
    write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas } })}\n`);
  },
});

onToolUpdate(event => {
  backgroundTaskTracker.recordToolEvent(event as any);
});

function parseUsageRequest(parsed: unknown): { id: string | number; command: string; cwd?: string; env?: Record<string, string> } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.method !== "provider/usage") return null;
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const params = record.params && typeof record.params === "object" ? (record.params as Record<string, unknown>) : undefined;
  const providerOptions =
    params?.providerOptions && typeof params.providerOptions === "object"
      ? (params.providerOptions as Record<string, unknown>)
      : undefined;
  const spec = experimental_acpLaunchSpecSchema.safeParse(providerOptions?.acpLaunchSpec);
  return {
    id,
    command: spec.success ? spec.data.command : "agy",
    cwd: spec.success ? spec.data.cwd : undefined,
    env: spec.success ? spec.data.env : undefined,
  };
}

function missingCliResponse(method: unknown) {
  switch (method) {
    case "provider/health":
      return { result: {
        supported: true,
        health: {
          status: "not_installed",
          statusMessage: null,
          accountEmail: null,
          planLabel: null,
          installedVersion: null,
          minimumSupportedVersion: null,
          canInstall: false,
          canUpdate: false,
          loginCommand: null,
        },
      } satisfies ProviderHealthResult };
    case "provider/usage":
      return { result: { supported: true, usage: { status: "not_installed" } } };
    case "provider/installation/status":
      return { result: {
        executableName: "agy",
        executablePath: null,
        installed: false,
        installSource: "notInstalled",
        currentVersion: null,
        latestVersion: null,
        minimumSupportedVersion: null,
        npmPackageName: null,
        npmGlobalPackageVersion: null,
        installAction: null,
        needsUpdate: false,
        versionUnsupported: false,
      } satisfies ProviderInstallationStatus };
    case "provider/installation/run":
      return { result: { available: false, message: "Antigravity CLI installation and updates are unavailable through BB." } };
    default:
      return { error: { code: -32000, message: "Antigravity CLI (agy) was not found on the agent host." } };
  }
}

let stdoutFilterInstalled = false;
const autoApproveThreads = new Map<string, boolean>();
const commandDescriptionsThreads = new Map<string, boolean>();
const sessionProfileStore = createSessionProfileStore({
  persistPath: defaultProfileBindingsPath(),
});
const pendingProfileBindings = new Map<string, { threadId: string; profileHash: string }>();

function recordSessionProfileFromResponse(line: string): string {
  if (pendingProfileBindings.size === 0) return line;
  let message: any;
  try { message = JSON.parse(line); } catch { return line; }
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return line;
  if (typeof message.id !== "string" && typeof message.id !== "number") return line;
  const key = String(message.id);
  const pending = pendingProfileBindings.get(key);
  if (!pending) return line;
  pendingProfileBindings.delete(key);
  const providerThreadId = message.result?.providerThreadId;
  if (typeof providerThreadId === "string" && providerThreadId.length > 0) {
    sessionProfileStore.bind({
      threadId: pending.threadId,
      providerThreadId,
      profileHash: pending.profileHash,
    });
  }
  return line;
}

function resolveRequestProfileHash(record: Record<string, any>): string | null {
  const options = record.params?.options;
  const spec = options?.providerOptions?.acpLaunchSpec;
  if (!spec || typeof spec !== "object") return null;
  const hostEnv = experimental_buildProviderCliEnv(spec.env);
  const profile = extractAntigravityProfileFromLaunchSpec(spec, hostEnv, options?.envVars);
  return hashAntigravityProfile(profile, hostEnv);
}

export function rememberApprovalSetting(request: any) {
  if (request?.method === "thread/stop" || request?.method === "thread/discard") {
    const threadId = request?.params?.threadId;
    if (typeof threadId === "string") {
      autoApproveThreads.delete(threadId);
      commandDescriptionsThreads.delete(threadId);
    }
    return;
  }
  const schema = request?.method === "thread/start" ? threadStartParamsSchema
    : request?.method === "thread/resume" ? threadResumeParamsSchema
    : request?.method === "turn/start" ? turnStartParamsSchema : null;
  const parsed = schema?.safeParse(request.params);
  if (parsed?.success) {
    const providerOptions = parsed.data.options.providerOptions;
    if (typeof providerOptions?.commandDescriptionsEnabled === "boolean") {
      commandDescriptionsThreads.set(parsed.data.threadId, providerOptions.commandDescriptionsEnabled);
    }
    autoApproveThreads.set(parsed.data.threadId,
      providerOptions?.autoApprove === true &&
      parsed.data.options.permissionMode === "accept-edits" && parsed.data.options.permissionEscalation === "ask");
  }
}

function applyAntigravityDefaults(line: string, parsed: unknown): { line: string; parsed: unknown } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { line, parsed };
  const record = parsed as Record<string, any>;
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? (record.params as Record<string, any>)
    : null;
  if (!params) return { line, parsed };
  const options = params.options && typeof params.options === "object" && !Array.isArray(params.options)
    ? (params.options as Record<string, any>)
    : null;
  const providerOptions = options?.providerOptions && typeof options.providerOptions === "object" && !Array.isArray(options.providerOptions)
    ? (options.providerOptions as Record<string, any>)
    : null;
  if (typeof params.threadId === "string" && typeof providerOptions?.commandDescriptionsEnabled === "boolean") {
    commandDescriptionsThreads.set(params.threadId, providerOptions.commandDescriptionsEnabled);
  }
  if (providerOptions && (!providerOptions.acpDialect || providerOptions.acpDialect === "acp")) {
    const updated = {
      ...record,
      params: {
        ...params,
        options: {
          ...options,
          providerOptions: {
            ...providerOptions,
            acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
          },
        },
      },
    };
    return { line: JSON.stringify(updated), parsed: updated };
  }
  return { line, parsed };
}

export function interceptApproval(line: string): boolean {
  if (interceptSubagentApproval(line)) return true;
  let message: any;
  try { message = JSON.parse(line); } catch { return false; }
  if (isSubagentApprovalForDisabledThread(message)) return false;
  if (message?.jsonrpc !== "2.0" || message.method !== "interaction/request" ||
      (typeof message.id !== "string" && typeof message.id !== "number") ||
      !autoApproveThreads.get(message.params?.threadId)) return false;
  const payload = message.params?.payload;
  if (payload?.kind !== "approval" || typeof payload.subject?.itemId !== "string" ||
      !["command", "file_change", "tool_use"].includes(payload.subject.kind) ||
      !(payload.reason === null || typeof payload.reason === "string") ||
      !Array.isArray(payload.availableDecisions) ||
      !payload.availableDecisions.every((value: unknown) => ["allow_once", "allow_for_session", "deny"].includes(value as string))) return false;
  const subject = payload.subject;
  if (subject.kind === "command" && (typeof subject.command !== "string" || !Array.isArray(subject.actions) || !(subject.cwd === null || typeof subject.cwd === "string") || subject.sessionGrant !== null)) return false;
  if (subject.kind === "file_change" && (!(subject.writeScope === null || typeof subject.writeScope === "string") || subject.sessionGrant !== null)) return false;
  if (subject.kind === "tool_use" && (typeof subject.tool !== "string" || typeof subject.presentation?.icon?.glyph !== "string" || typeof subject.presentation?.label?.pending !== "string" || typeof subject.presentation?.label?.completed !== "string")) return false;
  const decisions = payload.availableDecisions;
  const decision = decisions.includes("allow_once") ? "allow_once" : decisions.includes("allow_for_session") ? "allow_for_session" : null;
  if (!decision) return false;
  queueMicrotask(() => experimental_acpProviderBridge.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: message.id, result: { decision, grantedPermissions: null },
  })));
  return true;
}
function ensureStdoutFilter() {
  if (stdoutFilterInstalled) return;
  stdoutFilterInstalled = true;
  registerAntigravityAcpDialect();
  const write = process.stdout.write.bind(process.stdout);
  rawStdoutWrite = write;
  const output = modeControlOutput(
    interceptApproval,
    line => backgroundTaskTracker.processStdoutLine(
      applyThreadCommandDescriptions(recordSessionProfileFromResponse(line), commandDescriptionsThreads),
    ),
  );
  output.on("data", chunk => write(chunk));
  process.stdout.write = ((chunk: any, encodingOrCallback?: any, callback?: any) =>
    output.write(chunk, encodingOrCallback, callback)) as typeof process.stdout.write;
}

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  start() {
    ensureStdoutFilter();
  },
  handleLine(line: string) {
    ensureStdoutFilter();
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    const request = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
    if (request?.method !== "initialize" && !resolveAntigravityLaunchSpec(parsed)) {
      const id = request?.id;
      if (request?.jsonrpc === "2.0" && (typeof id === "string" || typeof id === "number")) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...missingCliResponse(request.method) })}\n`);
      }
      return;
    }

    if (request?.method === "thread/discard") {
      sessionProfileStore.forget({
        threadId: typeof request.params?.threadId === "string" ? request.params.threadId : undefined,
        providerThreadId: typeof request.params?.providerThreadId === "string" ? request.params.providerThreadId : undefined,
      });
    } else if (
      request &&
      (request.method === "thread/start" || request.method === "thread/resume" || request.method === "turn/start")
    ) {
      const profileHash = resolveRequestProfileHash(request);
      if (profileHash !== null) {
        const id = typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
        const threadId = typeof request.params?.threadId === "string" ? request.params.threadId : undefined;
        const providerThreadId = typeof request.params?.providerThreadId === "string"
          ? request.params.providerThreadId
          : undefined;
        if (
          (request.method === "thread/resume" || request.method === "turn/start") &&
          sessionProfileStore.checkMismatch({ threadId, providerThreadId, profileHash })
        ) {
          if (request.jsonrpc === "2.0" && id !== null) {
            process.stdout.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE,
              },
            })}\n`);
          }
          return;
        }
        if ((request.method === "thread/start" || request.method === "thread/resume") && id !== null && threadId) {
          pendingProfileBindings.set(String(id), { threadId, profileHash });
        }
      }
    }

    if (parsed !== null) line = JSON.stringify(parsed);
    const withDefaults = applyAntigravityDefaults(line, parsed);
    // Runs first: a steer into a held turn is rewritten to turn/start, which the transforms below
    // must then treat like any other turn/start.
    const inbound = backgroundTaskTracker.handleInbound(withDefaults.parsed);
    const routed = inbound.request === withDefaults.parsed
      ? withDefaults
      : { line: JSON.stringify(inbound.request), parsed: inbound.request };
    const subagentTransformed = transformSubagentRequest(routed.line, routed.parsed);
    rememberApprovalSetting(subagentTransformed.parsed);
    const closeDeltas = inbound.deltas;
    if (closeDeltas.length > 0) {
      const stopThreadId = (subagentTransformed.parsed as Record<string, any> | null)?.params?.threadId;
      if (typeof stopThreadId === "string") {
        const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
        write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId: stopThreadId, deltas: closeDeltas } })}\n`);
      }
    }
    const usageRequest = parseUsageRequest(subagentTransformed.parsed);
    if (usageRequest !== null) {
      void readAntigravityProviderUsage({
        command: usageRequest.command,
        cwd: usageRequest.cwd,
        env: { ...process.env, ...usageRequest.env },
      }).then(result => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: usageRequest.id, result })}\n`);
      }).catch(error => {
        const result = {
          supported: true,
          usage: {
            status: "error",
            message: error instanceof Error ? error.message : "Antigravity CLI usage could not be collected.",
            planLabel: null,
            accountEmail: null,
          },
        };
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: usageRequest.id, result })}\n`);
      });
      return;
    }
    experimental_acpProviderBridge.handleLine(mapPromptMode(subagentTransformed.line, subagentTransformed.parsed));
  },
};
