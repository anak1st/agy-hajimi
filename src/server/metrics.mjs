/**
 * Antigravity App 纯函数遥测与上下文窗口聚合引擎。
 *
 * 使用 BigInt 纳秒时间戳精确计算 TPS（消除 0.5s 阈值边界的浮点舍入误差，且绝不以 `streamingDuration` 作分母）。
 */

export const MIN_SPEED_DURATION_SEC = 0.5;
export const MIN_MEAN_OUTPUT_TOKENS = 50;

export function parseDurationSec(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseIsoNs(value) {
  if (typeof value !== 'string' || !value) return null;
  const m = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!m) return null;
  const ms = Date.parse(m[1] + m[3]);
  if (!Number.isFinite(ms)) return null;
  const fracNs = BigInt((m[2] || '').padEnd(9, '0'));
  return BigInt(Math.trunc(ms)) * 1_000_000n + fracNs;
}

export function computeDurationSec(startIso, endIso) {
  const s = parseIsoNs(startIso);
  const e = parseIsoNs(endIso);
  if (s === null || e === null || e <= s) return null;
  return Number(e - s) / 1e9;
}

function safeInt(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 0 ? Math.floor(val) : 0;
  }
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const n = Number(val.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }
  return 0;
}

export function buildModelLabelMap(userStatusRes) {
  const map = new Map();
  const configs = userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return map;
  for (const cfg of configs) {
    const label = String(cfg?.label || '').trim();
    const modelId = String(cfg?.modelOrAlias?.model || '').trim();
    const alias = String(cfg?.modelId || '').trim();
    if (modelId && label) map.set(modelId, label);
    if (alias && label) map.set(alias, label);
  }
  return map;
}

export function resolveModelLabel(rawModel, labelMap) {
  const key = String(rawModel || '').trim();
  if (!key) return 'Unknown Model';
  if (labelMap instanceof Map && labelMap.has(key)) {
    return labelMap.get(key);
  }
  return key
    .replace(/^MODEL_PLACEHOLDER_/i, 'Model ')
    .replace(/^models\//i, '');
}

function normalizeQuotaWindow(bucket, nowMs = Date.now()) {
  if (!bucket || typeof bucket !== 'object') return null;
  let remFrac = null;
  if (bucket.disabled === true) {
    remFrac = 0;
  } else if (
    bucket.remainingFraction !== undefined &&
    bucket.remainingFraction !== null &&
    Number.isFinite(Number(bucket.remainingFraction))
  ) {
    remFrac = Math.max(0, Math.min(1, Number(bucket.remainingFraction)));
  } else if (typeof bucket.resetTime === 'string' && bucket.resetTime.trim()) {
    const resetMs = Date.parse(bucket.resetTime);
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      remFrac = 0;
    }
  }
  if (remFrac === null) return null;
  return {
    remainingPct: +(remFrac * 100).toFixed(1),
    usedPct: +((1 - remFrac) * 100).toFixed(1),
    resetTime: bucket.resetTime || null,
    description: String(bucket.description || ''),
  };
}

export function normalizeQuotas(quotaRes, userStatusRes) {
  const payload = quotaRes?.response !== undefined ? quotaRes.response : quotaRes;
  const rawGroups = Array.isArray(payload?.groups) ? payload.groups : [];
  const nowMs = Date.now();
  const pools = [];

  for (const grp of rawGroups) {
    const name = String(grp?.displayName || 'Model Pool').trim();
    // 仅保留 Gemini 系列模型配额池
    if (!/gemini/i.test(name)) continue;
    const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
    let fiveHour = null;
    let weekly = null;

    for (const b of buckets) {
      const norm = normalizeQuotaWindow(b, nowMs);
      if (!norm) continue;
      const win = String(b?.window || '').toLowerCase();
      const id = String(b?.bucketId || '').toLowerCase();
      if (win === '5h' || id.includes('5h')) {
        fiveHour = norm;
      } else if (win === 'weekly' || win === '7d' || id.includes('weekly')) {
        weekly = norm;
      } else if (!fiveHour) {
        fiveHour = norm;
      } else if (!weekly) {
        weekly = norm;
      }
    }

    if (fiveHour || weekly) {
      pools.push({
        name,
        description: String(grp?.description || ''),
        fiveHour,
        weekly,
      });
    }
  }

  const userStatus = userStatusRes?.userStatus || {};
  const tierName = String(
    userStatus?.userTier?.name ||
    userStatus?.planStatus?.planInfo?.planName ||
    ''
  ).trim();

  return {
    tierName,
    pools,
  };
}

function summarizeConversationList(summariesRes) {
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

export function buildTelemetrySnapshot({
  summariesRes = null,
  trajectoryRes = null,
  userStatusRes = null,
  quotaRes = null,
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
    // 明确指定了目标会话 ID 时严格按 ID 匹配；若暂未索引则构造空占位，绝不回退显示上一个/其他会话的数据
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

  // 按 responseId / messageId 与 stepIndex 建立生成器元数据索引
  const genByResponseId = new Map();
  const genByStepIndex = new Map();
  for (const g of gens) {
    const chat = g?.chatModel;
    if (!chat) continue;
    const rid = String(chat.usage?.responseId || chat.usage?.messageId || '').trim();
    if (rid) genByResponseId.set(rid, chat);
    if (Array.isArray(g.stepIndices)) {
      for (const idx of g.stepIndices) {
        if (Number.isInteger(idx)) genByStepIndex.set(idx, chat);
      }
    }
  }

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

  const recentSteps = [];
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

    const chat = (rid && genByResponseId.get(rid)) || genByStepIndex.get(i) || null;
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
    const cacheHitPct = totalPrompt > 0 ? +((cacheReadTokens / totalPrompt) * 100).toFixed(1) : null;
    if (cacheHitPct !== null) latestCacheHitPct = cacheHitPct;

    const endIso = meta?.finishedGeneratingAt || meta?.completedAt || '';
    const durationSec = computeDurationSec(meta?.createdAt, endIso);
    let tps = null;
    if (durationSec !== null && durationSec >= MIN_SPEED_DURATION_SEC && outputTokens > 0) {
      tps = +(outputTokens / durationSec).toFixed(1);
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

    recentSteps.push({
      stepIndex: i + 1,
      modelLabel,
      tps,
      ttftSec: ttftSec !== null ? +ttftSec.toFixed(2) : null,
      durationSec: durationSec !== null ? +durationSec.toFixed(2) : null,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      cacheHitPct,
      contextTokens: cwUsed ?? (totalPrompt + outputTokens),
      maxContextTokens: cwMax,
      isCompaction,
      createdAt: String(meta?.createdAt || ''),
    });
  }

  // 若步骤内未携带上下文窗口数据，则回退读取最新一条 generatorMetadata
  if ((latestContextUsed === null || latestContextMax === null) && gens.length > 0) {
    for (let i = gens.length - 1; i >= 0; i -= 1) {
      const chat = gens[i]?.chatModel;
      const cw = chat?.chatStartMetadata?.contextWindowMetadata;
      const u = cw?.estimatedTokensUsed !== undefined ? safeInt(cw.estimatedTokensUsed) : null;
      const m = cw?.maxContextTokens !== undefined ? safeInt(cw.maxContextTokens) : null;
      if (u !== null && m !== null && m > 0) {
        latestContextUsed = u;
        latestContextMax = m;
        if (!latestModelLabel && chat?.model) {
          latestModelLabel = resolveModelLabel(chat.model, labelMap);
        }
        break;
      }
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
      modelCalls: recentSteps.length,
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
    recentSteps: recentSteps.slice(-40).reverse(),
  };
}
