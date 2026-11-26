/**
 * Context HUD (`agy-hajimi`) 后台守护进程入口。
 *
 * 负责响应前端通过 CDP Binding 发来的 `telemetry` / `refresh` 请求、调用 Language Server RPC 组装指标，
 * 并在收到 `SHUTDOWN_DISPOSE` 或退出信号时主动卸载所有窗口内的注入节点。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpBridge } from './cdp-bridge.mjs';
import {
  analyzeTrajectoryEconomics,
  findTargetQuotaGroup,
  summarizeHistoricalPool,
} from './economics.mjs';
import { createLsClient } from './ls-client.mjs';
import { readPluginVersion } from './mcp-entry.mjs';
import { buildTelemetrySnapshot, summarizeConversationList } from './metrics.mjs';
import { getUiBundleVersion, loadUiAssets } from './ui-loader.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(dirname(SERVER_DIR), 'ui');
const ECONOMICS_CACHE_TTL_MS = 10 * 60 * 1000; // 第二页额度推算最懒触发间隔：严格不快于 10 分钟

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
  const poolHistoryByScope = new Map(); // scopeKey:groupName -> { computedAtMs, conv5hMap, convWeeklyMap }
  const economicsCache = new Map(); // scopeKey:cascadeId -> { computedAtMs, data }

  async function computeLazyEconomics({
    scopeKey,
    remoteTarget,
    summariesRes,
    userStatusRes,
    quotaRes,
    activeCascadeId,
    activeTrajRes,
    fallbackModelLabel,
  }) {
    const nowMs = Date.now();
    const econKey = `${scopeKey}:${String(activeCascadeId || '_default').toLowerCase()}`;
    const cachedEcon = economicsCache.get(econKey);
    // 严格遵守不快于 10 分钟的惰性计算节流（即使手动 refresh 或 10 秒轮询也不重复算）
    if (cachedEcon && nowMs - cachedEcon.computedAtMs < ECONOMICS_CACHE_TTL_MS) {
      return cachedEcon.data;
    }

    const baseEcon = analyzeTrajectoryEconomics(activeTrajRes, userStatusRes, {
      nowMs,
      fallbackModelLabel,
    });
    const targetGroup = findTargetQuotaGroup(
      quotaRes,
      baseEcon.activeModel.label,
      baseEcon.activeModel.rawModel,
      userStatusRes,
      nowMs
    );

    let observed5hUsd = baseEcon.windows.window5hUsd;
    let observedWeeklyUsd = baseEcon.windows.windowWeeklyUsd;

    if (targetGroup) {
      const fiveHResetMs = targetGroup.fiveHour?.resetTime ? Date.parse(targetGroup.fiveHour.resetTime) : NaN;
      const weeklyResetMs = targetGroup.weekly?.resetTime ? Date.parse(targetGroup.weekly.resetTime) : NaN;
      const fiveHStartMs = Number.isFinite(fiveHResetMs) ? fiveHResetMs - 5 * 3600_000 : nowMs - 5 * 3600_000;
      const weeklyStartMs = Number.isFinite(weeklyResetMs) ? weeklyResetMs - 7 * 24 * 3600_000 : nowMs - 7 * 24 * 3600_000;

      const scopePoolKey = `${scopeKey}:${targetGroup.groupName}`;
      let poolHist = poolHistoryByScope.get(scopePoolKey);
      if (!poolHist || nowMs - poolHist.computedAtMs >= ECONOMICS_CACHE_TTL_MS) {
        const minCutoff = Math.min(fiveHStartMs, weeklyStartMs) - 3600_000;
        const convIdMap = new Map();
        for (const c of summarizeConversationList(summariesRes)) {
          const t = Date.parse(c.lastModifiedTime || '');
          if (!Number.isFinite(t) || t >= minCutoff) {
            convIdMap.set(c.cascadeId.toLowerCase(), c.cascadeId);
          }
        }
        // 本地会话补全磁盘 conversations/*.db 中未被当前窗口列出的历史对话
        if (!remoteTarget?.isRemote) {
          for (const item of lsClient.discoverLocalConversationIds({ minCutoffMs: minCutoff, limit: 60 })) {
            const lower = item.cascadeId.toLowerCase();
            if (!convIdMap.has(lower)) convIdMap.set(lower, item.cascadeId);
          }
        }
        const recentIds = Array.from(convIdMap.entries()).slice(0, 60);

        const activeLower = String(activeCascadeId || '').toLowerCase();
        const trajResults = await Promise.all(
          recentIds.map(async ([cidLower, cascadeId]) => {
            if (activeLower && cidLower === activeLower && activeTrajRes) {
              return { cidLower, traj: activeTrajRes };
            }
            const traj = await lsClient
              .callRpc('GetCascadeTrajectory', { cascadeId }, { timeoutMs: 4000, remoteTarget })
              .catch(() => lastValidTrajectories.get(`${scopeKey}:${cidLower}`) || null);
            return { cidLower, traj };
          })
        );

        let sum5h = 0;
        let sumWeekly = 0;
        for (const { traj } of trajResults) {
          if (!traj) continue;
          const res = analyzeTrajectoryEconomics(traj, userStatusRes, {
            nowMs,
            fiveHStartMs,
            weeklyStartMs,
            quotaGroupName: targetGroup.groupName,
            quotaGroupDesc: targetGroup.description,
          });
          sum5h += res.windows.window5hUsd;
          sumWeekly += res.windows.windowWeeklyUsd;
        }
        poolHist = { computedAtMs: nowMs, observed5hUsd: sum5h, observedWeeklyUsd: sumWeekly };
        poolHistoryByScope.set(scopePoolKey, poolHist);
      }

      observed5hUsd = poolHist.observed5hUsd;
      observedWeeklyUsd = poolHist.observedWeeklyUsd;
    }

    const calibration = summarizeHistoricalPool({
      targetGroup,
      observed5hUsd,
      observedWeeklyUsd,
      nowMs,
    });

    const data = {
      activeModel: baseEcon.activeModel,
      session: baseEcon.session,
      calibration,
    };
    if (economicsCache.size >= 30 && !economicsCache.has(econKey)) {
      const oldest = economicsCache.keys().next().value;
      if (oldest !== undefined) economicsCache.delete(oldest);
    }
    economicsCache.set(econKey, { computedAtMs: nowMs, data });
    return data;
  }

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

    const economics = await computeLazyEconomics({
      scopeKey,
      remoteTarget,
      summariesRes,
      userStatusRes,
      quotaRes,
      activeCascadeId,
      activeTrajRes: trajectoryRes,
      fallbackModelLabel: preSummary.activeConversation?.modelLabel || '',
    }).catch(() => null);

    return buildTelemetrySnapshot({
      summariesRes,
      trajectoryRes,
      userStatusRes,
      quotaRes,
      economics,
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
