/**
 * Antigravity App 会话级遥测与上下文窗口聚合引擎。
 *
 * 结合时间计算与配额归一化模块，严格按目标 `cascadeId` 汇总上下文占用、生成速率、TTFT 与 Token 消耗。
 */

import { buildModelLabelMap, normalizeQuotas, resolveModelLabel } from './quota.mjs';
import { computeDurationSec, parseDurationSec, safeInt } from './time-math.mjs';

export { computeDurationSec, parseDurationSec };

export const MIN_SPEED_DURATION_SEC = 0.5;
export const MIN_MEAN_OUTPUT_TOKENS = 50;

/** 从 GetAllCascadeTrajectories 响应提取排序后的会话列表 */
export function summarizeConversationList(summariesRes) {
  const rawMap = summariesRes?.trajectorySummaries;
  if (!rawMap || typeof rawMap !== 'object') return [];
  const list = [];
  for (const [cascadeId, info] of Object.entries(rawMap)) {
    if (!info || typeof info !== 'object') continue;
    const status = String(info.status || '');
    const wsPath = String(info.workspaces?.[0]?.workspaceFolderAbsoluteUri || '')
      .replace(/^file:\/\//i, '');
    const wsName = wsPath ? wsPath.split('/').filter(Boolean).pop() || '' : '';
    list.push({
      cascadeId,
      title: String(info.summary || '').trim() || cascadeId.slice(0, 8),
      status,
      isRunning: status === 'CASCADE_RUN_STATUS_RUNNING',
      stepCount: safeInt(info.stepCount),
      lastModifiedTime: String(info.lastModifiedTime || ''),
      workspaceName: wsName,
    });
  }
  list.sort((a, b) => (b.lastModifiedTime > a.lastModifiedTime ? 1 : b.lastModifiedTime < a.lastModifiedTime ? -1 : 0));
  return list;
}

/** 构建生成器元数据索引表（用于匹配 TTFT 与 contextWindowMetadata） */
function indexGeneratorMetadata(gens) {
  const byResponseId = new Map();
  const byStepIndex = new Map();
  for (const g of gens) {
    const chat = g?.chatModel;
    if (!chat) continue;
    const rid = String(chat.usage?.responseId || chat.usage?.messageId || '').trim();
    if (rid) byResponseId.set(rid, chat);
    if (Array.isArray(g.stepIndices)) {
      for (const idx of g.stepIndices) {
        if (Number.isInteger(idx)) byStepIndex.set(idx, chat);
      }
    }
  }
  return { byResponseId, byStepIndex };
}

/** 若步骤中未带上下文元数据，回退取最后一条 generatorMetadata 补全 */
function findFallbackContextWindow(gens, labelMap) {
  for (let i = gens.length - 1; i >= 0; i -= 1) {
    const chat = gens[i]?.chatModel;
    const cw = chat?.chatStartMetadata?.contextWindowMetadata;
    const used = cw?.estimatedTokensUsed !== undefined ? safeInt(cw.estimatedTokensUsed) : null;
    const max = cw?.maxContextTokens !== undefined ? safeInt(cw.maxContextTokens) : null;
    if (used !== null && max !== null && max > 0) {
      return {
        used,
        max,
        modelLabel: chat?.model ? resolveModelLabel(chat.model, labelMap) : '',
      };
    }
  }
  return null;
}

/** 聚合单会话遥测与账户配额快照 */
export function buildTelemetrySnapshot({
  summariesRes = null,
  trajectoryRes = null,
  userStatusRes = null,
  quotaRes = null,
  economics = null,
  selectedCascadeId = '',
  hostRouteCascadeId = '',
  endpointLabel = 'Local',
  isRemote = false,
  pluginVersion = '1.0.0',
} = {}) {
  const allConversations = summarizeConversationList(summariesRes);
  const conversations = allConversations.slice(0, 30);
  const labelMap = buildModelLabelMap(userStatusRes);

  const rawRequestedId = String(selectedCascadeId || hostRouteCascadeId || '').trim();
  const requestedId = rawRequestedId.toLowerCase();
  let targetConv = null;
  if (requestedId) {
    // 明确指定目标会话 ID 时严格按 ID 匹配；暂未索引时构造空占位，绝不泄露其他会话数据
    targetConv = allConversations.find((c) => c.cascadeId.toLowerCase() === requestedId) || {
      cascadeId: rawRequestedId,
      title: rawRequestedId.slice(0, 8),
      status: '',
      isRunning: false,
      stepCount: 0,
      lastModifiedTime: '',
      workspaceName: '',
    };
  } else {
    targetConv = conversations.find((c) => c.isRunning) || conversations[0] || null;
  }

  const traj = trajectoryRes?.trajectory || trajectoryRes || {};
  const steps = Array.isArray(traj.steps) ? traj.steps : [];
  const gens = Array.isArray(traj.generatorMetadata) ? traj.generatorMetadata : [];
  const { byResponseId, byStepIndex } = indexGeneratorMetadata(gens);

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let compactions = 0;

  let latestContextUsed = null;
  let latestContextMax = null;
  let latestModelLabel = '';
  let latestTps = null;
  let peakTps = null;
  let latestTtftSec = null;
  let latestCacheHitPct = null;

  let meanOutSum = 0;
  let meanDurSum = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let modelCalls = 0;
  const seenResponseIds = new Set();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const stepType = String(step?.type || '');
    const isCompaction = /COMPACTION|CHECKPOINT/.test(stepType);
    if (isCompaction) compactions += 1;

    const meta = step?.metadata;
    const usage = meta?.modelUsage;
    if (!usage || typeof usage !== 'object') continue;

    const rid = String(usage.responseId || usage.messageId || '').trim();
    if (rid && seenResponseIds.has(rid)) continue;
    if (rid) seenResponseIds.add(rid);
    modelCalls += 1;

    const chat = (rid && byResponseId.get(rid)) || byStepIndex.get(i) || null;
    const rawModel = usage.model || meta?.generatorModel || chat?.model || meta?.requestedModel || '';
    const modelLabel = resolveModelLabel(rawModel, labelMap);
    if (modelLabel) latestModelLabel = modelLabel;

    const inputTokens = safeInt(usage.inputTokens);
    const cacheReadTokens = safeInt(usage.cacheReadTokens);
    const outputTokens = safeInt(usage.outputTokens);
    const thinkingTokens = safeInt(usage.thinkingOutputTokens);
    const responseTokens = usage.responseOutputTokens !== undefined
      ? safeInt(usage.responseOutputTokens)
      : Math.max(0, outputTokens - thinkingTokens);

    totalInputTokens += inputTokens;
    totalCacheReadTokens += cacheReadTokens;
    totalOutputTokens += outputTokens;
    totalThinkingTokens += thinkingTokens;
    totalResponseTokens += responseTokens;

    const totalPrompt = inputTokens + cacheReadTokens;
    if (totalPrompt > 0) {
      latestCacheHitPct = +((cacheReadTokens / totalPrompt) * 100).toFixed(1);
    }

    const endIso = meta?.finishedGeneratingAt || meta?.completedAt || '';
    const durationSec = computeDurationSec(meta?.createdAt, endIso);
    if (durationSec !== null && durationSec >= MIN_SPEED_DURATION_SEC && outputTokens > 0) {
      const tps = +(outputTokens / durationSec).toFixed(1);
      latestTps = tps;
      if (peakTps === null || tps > peakTps) peakTps = tps;
      if (!isCompaction && outputTokens >= MIN_MEAN_OUTPUT_TOKENS) {
        meanOutSum += outputTokens;
        meanDurSum += durationSec;
      }
    }

    const ttftSec = parseDurationSec(chat?.timeToFirstToken);
    if (ttftSec !== null) {
      latestTtftSec = +ttftSec.toFixed(2);
      if (!isCompaction) {
        ttftSum += ttftSec;
        ttftCount += 1;
      }
    }

    const cw = chat?.chatStartMetadata?.contextWindowMetadata;
    const cwUsed = cw?.estimatedTokensUsed !== undefined ? safeInt(cw.estimatedTokensUsed) : null;
    const cwMax = cw?.maxContextTokens !== undefined ? safeInt(cw.maxContextTokens) : null;
    if (cwUsed !== null && cwMax !== null && cwMax > 0) {
      latestContextUsed = cwUsed;
      latestContextMax = cwMax;
    }
  }

  if ((latestContextUsed === null || latestContextMax === null) && gens.length > 0) {
    const fb = findFallbackContextWindow(gens, labelMap);
    if (fb) {
      latestContextUsed = fb.used;
      latestContextMax = fb.max;
      if (!latestModelLabel && fb.modelLabel) latestModelLabel = fb.modelLabel;
    }
  }

  const contextUsedPct =
    latestContextUsed !== null && latestContextMax !== null && latestContextMax > 0
      ? Math.min(100, +((latestContextUsed / latestContextMax) * 100).toFixed(1))
      : null;
  const contextRemaining =
    latestContextUsed !== null && latestContextMax !== null && latestContextMax > 0
      ? Math.max(0, latestContextMax - latestContextUsed)
      : null;

  const avgTps = meanDurSum > 0 ? +(meanOutSum / meanDurSum).toFixed(1) : null;
  const avgTtftSec = ttftCount > 0 ? +(ttftSum / ttftCount).toFixed(2) : null;
  const sessionPromptTotal = totalInputTokens + totalCacheReadTokens;
  const sessionCacheHitPct =
    sessionPromptTotal > 0 ? +((totalCacheReadTokens / sessionPromptTotal) * 100).toFixed(1) : null;

  return {
    timestampMs: Date.now(),
    pluginVersion,
    endpoint: {
      label: endpointLabel,
      isRemote: Boolean(isRemote),
    },
    conversations,
    activeConversation: targetConv
      ? {
          cascadeId: targetConv.cascadeId,
          title: targetConv.title,
          isRunning: targetConv.isRunning,
          stepCount: targetConv.stepCount,
          workspaceName: targetConv.workspaceName,
          modelLabel: latestModelLabel || 'Unknown Model',
        }
      : null,
    context: {
      usedTokens: latestContextUsed,
      maxTokens: latestContextMax,
      usedPct: contextUsedPct,
      remainingTokens: contextRemaining,
      compactions,
    },
    performance: {
      latestTps,
      avgTps,
      peakTps,
      latestTtftSec,
      avgTtftSec,
      latestCacheHitPct,
      sessionCacheHitPct,
      modelCalls,
    },
    tokens: {
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      thinkingTokens: totalThinkingTokens,
      responseTokens: totalResponseTokens,
      totalTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
    },
    quotas: normalizeQuotas(quotaRes, userStatusRes),
    economics,
  };
}
