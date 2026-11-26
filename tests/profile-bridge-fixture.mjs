import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const root = process.argv[3];
assert.ok(mode && root, 'Usage: profile-bridge-fixture.mjs <mode> <root>');

const stateDir = join(root, 'state');
const hostBin = join(root, 'host-bin');
const emptyHostBin = join(root, 'empty-host-bin');
const untrustedBin = join(root, 'untrusted-bin');
const defaultHome = join(root, 'default-home');
const alphaGeminiDir = join(root, 'profile-alpha', '.gemini');
const betaGeminiDir = join(root, 'profile-beta-root');
const betaAppDataDir = 'work-app';
const invocationLog = join(root, 'invocations.jsonl');
const untrustedFlag = join(root, 'untrusted-executed.txt');
const sessionsRecordPath = join(root, 'started-sessions.json');

process.env.BB_ANTIGRAVITY_TASK_STATE_DIR = stateDir;
process.env.SYNTHETIC_AGY_LOG = invocationLog;

const { experimental_providerBridge: bridge } = await import('../host.ts');

const originalWrite = process.stdout.write.bind(process.stdout);
const messages = [];
let pending = '';
process.stdout.write = chunk => {
  pending += String(chunk);
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    messages.push(JSON.parse(pending.slice(0, end)));
    pending = pending.slice(end + 1);
  }
  return true;
};

let nextId = 1;
const send = (method, params) => {
  const id = nextId++;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return id;
};

const wait = async predicate => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
  throw new Error('Timed out waiting for message: ' + JSON.stringify(messages));
};

function readInvocations() {
  if (!existsSync(invocationLog)) return [];
  return readFileSync(invocationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function makeLaunchSpec({ pathDir = hostBin, extraHostEnv = {} } = {}) {
  return {
    displayName: 'Antigravity CLI',
    command: 'agy',
    args: ['acp', '--disable-telemetry'],
    env: {
      PATH: pathDir,
      HOME: defaultHome,
      USERPROFILE: defaultHome,
      LOCALAPPDATA: defaultHome,
      SYNTHETIC_AGY_LOG: invocationLog,
      ...extraHostEnv,
    },
  };
}

function makeOptions(envVars, specOptions) {
  return {
    permissionMode: 'accept-edits',
    permissionScope: 'workspace',
    approvalReviewer: 'user',
    permissionEscalation: 'ask',
    ...(envVars !== undefined ? { envVars } : {}),
    providerOptions: {
      acpLaunchSpec: makeLaunchSpec(specOptions),
    },
  };
}

function extractTurnPayload(threadId, fromIndex) {
  for (let i = fromIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.method !== 'thread/delta' || msg.params?.threadId !== threadId) continue;
    for (const delta of msg.params.deltas ?? []) {
      const text = delta.text ?? delta.delta ?? delta.item?.text ?? '';
      if (typeof text === 'string' && text.includes('"accountId"')) {
        return JSON.parse(text);
      }
    }
  }
  return null;
}

async function runTurn(threadId, providerThreadId, clientRequestId, envVars) {
  const startIdx = messages.length;
  const reqId = send('turn/start', {
    threadId,
    providerThreadId,
    clientRequestId,
    input: [{ type: 'text', text: 'identify' }],
    options: makeOptions(envVars),
  });
  const response = await wait(m => m.id === reqId);
  assert.ok(!response.error, `turn/start failed: ${JSON.stringify(response)}`);
  await wait(() => extractTurnPayload(threadId, startIdx) !== null);
  return extractTurnPayload(threadId, startIdx);
}

const alphaEnv = {
  PATH: untrustedBin,
  LOCALAPPDATA: untrustedBin,
  BB_ANTIGRAVITY_GEMINI_DIR: alphaGeminiDir,
  BB_ANTIGRAVITY_APP_DATA_DIR: 'antigravity-cli',
};

const betaEnv = {
  PATH: untrustedBin,
  LOCALAPPDATA: untrustedBin,
  BB_ANTIGRAVITY_GEMINI_DIR: betaGeminiDir,
  BB_ANTIGRAVITY_APP_DATA_DIR: betaAppDataDir,
};

try {
  const initId = send('initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  assert.ok((await wait(m => m.id === initId)).result);

  if (mode === 'missing-host-agy') {
    const startId = send('thread/start', {
      threadId: 'thread-missing',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions({ PATH: untrustedBin, LOCALAPPDATA: untrustedBin }, { pathDir: emptyHostBin }),
    });
    const startRes = await wait(m => m.id === startId);
    assert.ok(startRes.error, `expected missing host CLI error, got ${JSON.stringify(startRes)}`);
    assert.ok(!startRes.error.message.includes(untrustedBin), `error must not reference session PATH: ${startRes.error.message}`);

    const healthId = send('provider/health', {
      providerId: 'antigravity-cli',
      providerOptions: { acpLaunchSpec: makeLaunchSpec({ pathDir: emptyHostBin }) },
      envVars: { PATH: untrustedBin, LOCALAPPDATA: untrustedBin },
    });
    const healthRes = await wait(m => m.id === healthId);
    assert.equal(healthRes.result?.supported, true);
    assert.equal(healthRes.result?.health?.status, 'not_installed');

    const usageId = send('provider/usage', {
      providerId: 'antigravity-cli',
      providerOptions: { acpLaunchSpec: makeLaunchSpec({ pathDir: emptyHostBin }) },
      envVars: { PATH: untrustedBin, LOCALAPPDATA: untrustedBin },
    });
    const usageRes = await wait(m => m.id === usageId);
    assert.equal(usageRes.result?.supported, true);
    assert.equal(usageRes.result?.usage?.status, 'not_installed');

    assert.equal(existsSync(untrustedFlag), false, 'untrusted session PATH executable must never run');
    assert.deepEqual(readInvocations(), []);
  } else if (mode === 'phase1-start') {
    const startAlphaId = send('thread/start', {
      threadId: 'thread-alpha',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv),
    });
    const startedAlpha = await wait(m => m.id === startAlphaId);
    const alphaSessionId = startedAlpha.result?.providerThreadId;
    assert.ok(alphaSessionId, JSON.stringify(startedAlpha));
    const alphaTurn1 = await runTurn('thread-alpha', alphaSessionId, 'creq_23456789aa', alphaEnv);
    assert.deepEqual(alphaTurn1, { accountId: 'synthetic-alpha', sessionId: alphaSessionId, resumed: false });

    const startBetaId = send('thread/start', {
      threadId: 'thread-beta',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(betaEnv),
    });
    const startedBeta = await wait(m => m.id === startBetaId);
    const betaSessionId = startedBeta.result?.providerThreadId;
    assert.ok(betaSessionId, JSON.stringify(startedBeta));
    const betaTurn1 = await runTurn('thread-beta', betaSessionId, 'creq_23456789ab', betaEnv);
    assert.deepEqual(betaTurn1, { accountId: 'synthetic-beta', sessionId: betaSessionId, resumed: false });

    // Built-in provider/usage stays host-scoped and ignores routed request envVars
    const routedUsageId = send('provider/usage', {
      providerId: 'antigravity-cli',
      providerOptions: { acpLaunchSpec: makeLaunchSpec() },
      envVars: alphaEnv,
    });
    const routedUsageRes = await wait(m => m.id === routedUsageId);
    assert.equal(routedUsageRes.result?.usage?.status, 'ok');
    assert.deepEqual(
      routedUsageRes.result.usage.windows.map(w => [w.label, w.usedPercent]),
      [['Gemini 7d', 99], ['Claude/GPT 5h', 98]],
    );

    // Host-configured dedicated profile env does scope the host's Usage row
    const hostProfileUsageId = send('provider/usage', {
      providerId: 'antigravity-cli',
      providerOptions: {
        acpLaunchSpec: makeLaunchSpec({
          extraHostEnv: {
            BB_ANTIGRAVITY_GEMINI_DIR: alphaGeminiDir,
            BB_ANTIGRAVITY_APP_DATA_DIR: 'antigravity-cli',
          },
        }),
      },
    });
    const hostProfileUsageRes = await wait(m => m.id === hostProfileUsageId);
    assert.equal(hostProfileUsageRes.result?.usage?.status, 'ok');
    assert.deepEqual(
      hostProfileUsageRes.result.usage.windows.map(w => [w.label, w.usedPercent]),
      [['Gemini 7d', 20], ['Claude/GPT 5h', 15]],
    );

    assert.equal(existsSync(untrustedFlag), false, 'untrusted session PATH executable must never run');
    writeFileSync(sessionsRecordPath, JSON.stringify({ alphaSessionId, betaSessionId }));
  } else if (mode === 'phase2-restart-and-resume') {
    const { alphaSessionId, betaSessionId } = JSON.parse(readFileSync(sessionsRecordPath, 'utf8'));

    // 1. Disappeared env contribution after host restart must fail visibly before opening default account
    const missingEnvResumeId = send('thread/resume', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions({}),
    });
    const missingEnvRes = await wait(m => m.id === missingEnvResumeId);
    assert.ok(missingEnvRes.error, `expected profile mismatch error, got ${JSON.stringify(missingEnvRes)}`);
    assert.match(missingEnvRes.error.message, /different profile/i);
    assert.deepEqual(readInvocations(), [], 'disappeared env resume must not spawn agy');

    // 2. Switching Profile A -> Profile B must fail visibly before opening Profile B
    const wrongProfileResumeId = send('thread/resume', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(betaEnv),
    });
    const wrongProfileRes = await wait(m => m.id === wrongProfileResumeId);
    assert.ok(wrongProfileRes.error, `expected profile mismatch error, got ${JSON.stringify(wrongProfileRes)}`);
    assert.match(wrongProfileRes.error.message, /different profile/i);
    assert.deepEqual(readInvocations(), [], 'Profile A -> B resume must not spawn agy');

    // 3. Restoring Profile A resumes Thread A cleanly on synthetic-alpha
    const resumeAlphaId = send('thread/resume', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv),
    });
    const resumedAlpha = await wait(m => m.id === resumeAlphaId);
    assert.equal(resumedAlpha.result?.providerThreadId, alphaSessionId, JSON.stringify(resumedAlpha));
    const alphaTurn2 = await runTurn('thread-alpha', alphaSessionId, 'creq_23456789ac', alphaEnv);
    assert.deepEqual(alphaTurn2, { accountId: 'synthetic-alpha', sessionId: alphaSessionId, resumed: true });

    // 4. Mid-thread turn/start switching Profile A -> Profile B must also fail visibly before opening Profile B
    const invocationsBeforeDrift = readInvocations().length;
    const driftTurnId = send('turn/start', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      clientRequestId: 'creq_23456789ae',
      input: [{ type: 'text', text: 'drift' }],
      options: makeOptions(betaEnv),
    });
    const driftTurnRes = await wait(m => m.id === driftTurnId);
    assert.ok(driftTurnRes.error, `expected profile mismatch error on turn/start, got ${JSON.stringify(driftTurnRes)}`);
    assert.match(driftTurnRes.error.message, /different profile/i);
    assert.equal(readInvocations().length, invocationsBeforeDrift, 'drifted turn/start must not spawn Profile B');

    // 5. Switching Profile B -> Profile A must fail visibly before opening Profile A
    const invocationsBeforeBetaMismatch = readInvocations().length;
    const betaMismatchId = send('thread/resume', {
      threadId: 'thread-beta',
      providerThreadId: betaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv),
    });
    const betaMismatchRes = await wait(m => m.id === betaMismatchId);
    assert.ok(betaMismatchRes.error, `expected profile mismatch error, got ${JSON.stringify(betaMismatchRes)}`);
    assert.match(betaMismatchRes.error.message, /different profile/i);
    assert.equal(readInvocations().length, invocationsBeforeBetaMismatch, 'Profile B -> A resume must not spawn agy');

    // 6. Restoring Profile B resumes Thread B cleanly on synthetic-beta
    const resumeBetaId = send('thread/resume', {
      threadId: 'thread-beta',
      providerThreadId: betaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(betaEnv),
    });
    const resumedBeta = await wait(m => m.id === resumeBetaId);
    assert.equal(resumedBeta.result?.providerThreadId, betaSessionId, JSON.stringify(resumedBeta));
    const betaTurn2 = await runTurn('thread-beta', betaSessionId, 'creq_23456789ad', betaEnv);
    assert.deepEqual(betaTurn2, { accountId: 'synthetic-beta', sessionId: betaSessionId, resumed: true });

    assert.equal(existsSync(untrustedFlag), false, 'untrusted session PATH executable must never run');
  } else {
    throw new Error(`Unknown fixture mode: ${mode}`);
  }

  bridge.onClose?.();
  originalWrite('verified\n');
} catch (error) {
  process.stderr.write(String(error?.stack || error) + '\n');
  bridge.onClose?.();
  process.exitCode = 1;
}
