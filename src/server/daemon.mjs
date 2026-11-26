/**
 * Context HUD (`agy-hajimi`) 后台守护进程入口。
 *
 * 负责响应前端通过 CDP Binding 发来的 `telemetry` / `refresh` 请求、调用 Language Server RPC 组装指标，
 * 并在收到 `SHUTDOWN_DISPOSE` 或退出信号时主动卸载所有窗口内的注入节点。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpBridge } from './cdp-bridge.mjs';
import { createLsClient } from './ls-client.mjs';
import { readPluginVersion } from './mcp-entry.mjs';
import { buildTelemetrySnapshot } from './metrics.mjs';
import { getUiBundleVersion, loadUiAssets } from './ui-loader.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(dirname(SERVER_DIR), 'ui');

export function startDaemon() {
  const pluginVersion = readPluginVersion();
  let shuttingDown = false;
  let bridge = null;

  const lsClient = createLsClient({
    remoteWindowRpc: (session, method, body, timeoutMs) =>
      bridge.remoteWindowRpc(session, method, body, timeoutMs),
  });

  const lastValidSummaries = new Map();
  const lastValidTrajectories = new Map();

  async function handleBridgeRequest(session, action, params = {}) {
    if (action !== 'telemetry' && action !== 'refresh') {
      throw new Error(`Unknown action: ${action}`);
    }

    const force = action === 'refresh' || params?.force === true;
    const remoteTarget = session?.isRemote ? session : null;
    const scopeKey = remoteTarget ? String(remoteTarget.wsUrl || remoteTarget.endpointLabel || 'remote') : 'local';

    let [summariesRes, userStatusRes, quotaRes] = await Promise.all([
      lsClient.callRpc('GetAllCascadeTrajectories', {}, { timeoutMs: 4000, remoteTarget }).catch(() => null),
      lsClient.getUserStatus({ force, remoteTarget }).catch(() => null),
      lsClient.getQuotaSummary({ remoteTarget }).catch(() => null),
    ]);

    if (summariesRes?.trajectorySummaries && Object.keys(summariesRes.trajectorySummaries).length > 0) {
      lastValidSummaries.set(scopeKey, summariesRes);
    } else if (lastValidSummaries.has(scopeKey)) {
      summariesRes = lastValidSummaries.get(scopeKey);
    }

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
      const trajKey = `${scopeKey}:${activeCascadeId.toLowerCase()}`;
      trajectoryRes = await lsClient
        .callRpc('GetCascadeTrajectory', { cascadeId: activeCascadeId }, { timeoutMs: 5000, remoteTarget })
        .catch(() => null);
      if (trajectoryRes && (trajectoryRes.trajectory || Array.isArray(trajectoryRes.steps))) {
        if (lastValidTrajectories.size >= 30 && !lastValidTrajectories.has(trajKey)) {
          const oldestKey = lastValidTrajectories.keys().next().value;
          if (oldestKey !== undefined) lastValidTrajectories.delete(oldestKey);
        }
        lastValidTrajectories.set(trajKey, trajectoryRes);
      } else if (lastValidTrajectories.has(trajKey)) {
        trajectoryRes = lastValidTrajectories.get(trajKey);
      }
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
    loadAssets: () => loadUiAssets(UI_DIR),
    getBundleVersion: () => getUiBundleVersion(UI_DIR),
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

  process.stdin.setEncoding('utf8');
  let stdinBuf = '';
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    if (stdinBuf.includes('SHUTDOWN_DISPOSE')) {
      void shutdown({ disposeWindows: true, exitCode: 0 });
    }
  });
  process.stdin.on('end', () => {
    void shutdown({ disposeWindows: true, exitCode: 0 });
  });

  process.on('SIGINT', () => void shutdown({ disposeWindows: true, exitCode: 0 }));
  process.on('SIGTERM', () => void shutdown({ disposeWindows: true, exitCode: 0 }));
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  startDaemon();
}
