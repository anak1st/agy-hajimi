/**
 * Context HUD (`agy-hajimi`) 后台守护进程入口。
 *
 * 负责响应前端通过 CDP Binding 发来的 `telemetry` / `refresh` 请求、调用 Language Server RPC 组装指标，
 * 并在收到 `SHUTDOWN_DISPOSE` 或退出信号时主动卸载所有窗口内的注入节点。
 */

import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpBridge } from './cdp-bridge.mjs';
import { createLsClient } from './ls-client.mjs';
import { readPluginVersion } from './mcp-entry.mjs';
import { buildTelemetrySnapshot } from './metrics.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(dirname(SERVER_DIR), 'ui');
const CSS_PATH = join(UI_DIR, 'overlay.css');
const JS_PATH = join(UI_DIR, 'overlay.js');

function computeBundleVersion() {
  try {
    const cssStat = statSync(CSS_PATH);
    const jsStat = statSync(JS_PATH);
    return `${Math.trunc(cssStat.mtimeMs)}-${Math.trunc(jsStat.mtimeMs)}`;
  } catch {
    return '1';
  }
}

export function startDaemon() {
  const pluginVersion = readPluginVersion();
  let shuttingDown = false;
  let bridge = null;

  const lsClient = createLsClient({
    remoteWindowRpc: (session, method, body, timeoutMs) =>
      bridge.remoteWindowRpc(session, method, body, timeoutMs),
  });

  async function handleBridgeRequest(session, action, params = {}) {
    if (action !== 'telemetry' && action !== 'refresh') {
      throw new Error(`Unknown action: ${action}`);
    }

    const force = action === 'refresh' || params?.force === true;
    const remoteTarget = session?.isRemote ? session : null;

    const [summariesRes, userStatusRes, quotaRes] = await Promise.all([
      lsClient.callRpc('GetAllCascadeTrajectories', {}, { timeoutMs: 4000, remoteTarget }).catch(() => null),
      lsClient.getUserStatus({ force, remoteTarget }).catch(() => null),
      lsClient.getQuotaSummary({ force, remoteTarget }).catch(() => null),
    ]);

    const selectedCascadeId = String(params?.selectedCascadeId || '').trim();
    const hostRouteCascadeId = String(params?.hostRouteCascadeId || '').trim();

    const preSummary = buildTelemetrySnapshot({
      summariesRes,
      userStatusRes,
      quotaRes,
      selectedCascadeId,
      hostRouteCascadeId,
      endpointLabel: session?.endpointLabel || 'Local',
      isRemote: Boolean(session?.isRemote),
      pluginVersion,
    });

    let trajectoryRes = null;
    const activeCascadeId = preSummary.activeConversation?.cascadeId || selectedCascadeId || hostRouteCascadeId;
    if (activeCascadeId) {
      trajectoryRes = await lsClient
        .callRpc('GetCascadeTrajectory', { cascadeId: activeCascadeId }, { timeoutMs: 5000, remoteTarget })
        .catch(() => null);
    }

    return buildTelemetrySnapshot({
      summariesRes,
      trajectoryRes,
      userStatusRes,
      quotaRes,
      selectedCascadeId,
      hostRouteCascadeId,
      endpointLabel: session?.endpointLabel || 'Local',
      isRemote: Boolean(session?.isRemote),
      pluginVersion,
    });
  }

  bridge = createCdpBridge({
    loadAssets: async () => {
      const [css, js] = await Promise.all([
        readFile(CSS_PATH, 'utf8'),
        readFile(JS_PATH, 'utf8'),
      ]);
      return { css, js };
    },
    getBundleVersion: computeBundleVersion,
    getLocalHubInfo: () => lsClient.getLocalHubPorts(),
    onRequest: handleBridgeRequest,
  });

  bridge.start();

  async function shutdown({ disposeWindows = true, exitCode = 0 } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(exitCode), 1500);
    forceTimer.unref?.();
    try {
      await bridge.stop({ disposeWindows });
    } catch {
      // 退出清理阶段忽略瞬时异常
    } finally {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    }
  }

  let stdinBuf = '';
  let sawDispose = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuf += String(chunk || '');
    if (stdinBuf.includes('SHUTDOWN_DISPOSE')) {
      sawDispose = true;
      void shutdown({ disposeWindows: true, exitCode: 0 });
    } else if (stdinBuf.length > 4096) {
      stdinBuf = stdinBuf.slice(-1024);
    }
  });
  process.stdin.on('end', () => void shutdown({ disposeWindows: sawDispose, exitCode: 0 }));
  process.stdin.on('close', () => void shutdown({ disposeWindows: sawDispose, exitCode: 0 }));
  process.on('SIGTERM', () => void shutdown({ disposeWindows: true, exitCode: 0 }));
  process.on('SIGINT', () => void shutdown({ disposeWindows: true, exitCode: 0 }));
  process.stdin.resume();

  return bridge;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startDaemon();
}
