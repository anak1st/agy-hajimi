/**
 * 模型外部公开 API 定价、会话等效美刀费用与 10 分钟配额池增量校准模块。
 *
 * 原则：
 * 1. 通过 `clientModelConfigs` 的 `label` / `alias` 动态匹配当前模型价格系列，不死绑易变占位符。
 * 2. 仅依据外部公开 API 单价与实时观测到的 `(ΔUSD, ΔquotaFraction)` 独立校准 5h/周池，不做 `4x` 等先验假设或月度推测。
 */

import { analyzeQuotaWindow, buildModelLabelMap, normalizeQuotaWindow, resolveModelLabel } from './quota.mjs';
import { safeInt } from './time-math.mjs';

const STANDARD_MODEL_RATES = [
  { pattern: /\bhydrogen\b/i, family: 'Gemini 4 Hydrogen', inputPerM: 1.5, cachePerM: 0.075, outputPerM: 7.5 },
  { pattern: /\bneon\b/i, family: 'Gemini 4 Neon', inputPerM: 3.0, cachePerM: 0.15, outputPerM: 15.0 },
  { pattern: /\bcarbon\b/i, family: 'Gemini 4 Carbon', inputPerM: 4.0, cachePerM: 0.2, outputPerM: 20.0 },
  { pattern: /\bargon\b/i, family: 'Gemini 4 Argon', inputPerM: 4.0, cachePerM: 0.2, outputPerM: 20.0 },
];

/** 去除模型名称末尾的思考强度后缀，如 (High) / (Medium) / (Low) / (XHigh) */
export function stripEffortSuffix(label) {
  return String(label || '')
    .replace(/\s*\((?:low|medium|high|xhigh|extra\s*high)\)\s*$/i, '')
    .trim();
}

/**
 * 解析单个模型标识的外部公开 API 单价（USD / 1M tokens）。
 * 优先按 `clientModelConfigs` 中的可读名与别名匹配，避免占位符 ID 变更后失效。
 */
export function buildModelMetaMap(userStatusRes) {
  const map = new Map();
  const configs = userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return map;
  for (const cfg of configs) {
    const label = String(cfg?.label || '').trim();
    const modelId = String(cfg?.modelOrAlias?.model || '').trim();
    const alias = String(cfg?.modelId || '').trim();
    const entry = { label, alias, modelId };
    if (modelId) map.set(modelId, entry);
    if (alias) map.set(alias, entry);
  }
  return map;
}

/** 根据模型系列名解析公开 API 标准定价（Standard Tier） */
export function resolveModelPricing(rawModel, userStatusResOrMetaMap = null) {
  const key = String(rawModel || '').trim();
  const metaMap =
    userStatusResOrMetaMap instanceof Map
      ? userStatusResOrMetaMap
      : buildModelMetaMap(userStatusResOrMetaMap);
  const labelMap =
    userStatusResOrMetaMap instanceof Map
      ? null
      : buildModelLabelMap(userStatusResOrMetaMap);

  const meta = key ? metaMap.get(key) : null;
  const label = meta?.label || (labelMap ? resolveModelLabel(key, labelMap) : key || 'Unknown Model');
  const alias = meta?.alias || '';
  const searchText = `${label} ${alias} ${key}`;

  for (const rate of STANDARD_MODEL_RATES) {
    if (rate.pattern.test(searchText)) {
      return {
        priced: true,
        family: rate.family,
        label,
        inputPerM: rate.inputPerM,
        cachePerM: rate.cachePerM,
        outputPerM: rate.outputPerM,
      };
    }
  }

  return {
    priced: false,
    family: label || 'Unknown Model',
    label,
    inputPerM: null,
    cachePerM: null,
    outputPerM: null,
  };
}

/** 从配额接口原始响应中提取与当前模型匹配的配额组及高精度剩余比例 */
export function findTargetQuotaGroup(quotaRes, activeModelLabel, activeRawModel, userStatusRes = null, nowMs = Date.now()) {
  const payload = quotaRes?.response !== undefined ? quotaRes.response : quotaRes;
  const rawGroups = Array.isArray(payload?.groups) ? payload.groups : [];
  if (rawGroups.length === 0) return null;

  const metaMap = buildModelMetaMap(userStatusRes);
  const meta = activeRawModel ? metaMap.get(String(activeRawModel).trim()) : null;
  const baseLabel = stripEffortSuffix(activeModelLabel || meta?.label || '');

  let matched = null;
  if (baseLabel && !/^unknown model$/i.test(baseLabel)) {
    const needle = baseLabel.toLowerCase();
    matched = rawGroups.find((g) => {
      const text = `${g?.displayName || ''} ${g?.description || ''}`.toLowerCase();
      return text.includes(needle);
    }) || null;
  }

  // 若暂未识别到具体归属组，回退到 Gemini 组或首个可用组
  if (!matched) {
    matched = rawGroups.find((g) => /gemini/i.test(String(g?.displayName || ''))) || rawGroups[0];
  }

  const buckets = Array.isArray(matched?.buckets) ? matched.buckets : [];
  const extractRawBucket = (pred) => {
    const b = buckets.find(pred);
    if (!b) return null;
    const norm = normalizeQuotaWindow(b, nowMs);
    if (!norm) return null;
    const remFrac =
      b.disabled === true
        ? 0
        : b.remainingFraction !== undefined && b.remainingFraction !== null && Number.isFinite(Number(b.remainingFraction))
          ? Math.max(0, Math.min(1, Number(b.remainingFraction)))
          : norm.remainingPct / 100;
    return {
      ...norm,
      remainingFrac: remFrac,
      usedFrac: Math.max(0, 1 - remFrac),
    };
  };

  let fiveHour = extractRawBucket((b) => String(b?.window || '').toLowerCase() === '5h' || String(b?.bucketId || '').toLowerCase().includes('5h'));
  let weekly = extractRawBucket((b) => {
    const w = String(b?.window || '').toLowerCase();
    const id = String(b?.bucketId || '').toLowerCase();
    return w === 'weekly' || w === '7d' || id.includes('weekly');
  });

  if (!fiveHour && buckets[0]) fiveHour = extractRawBucket((b) => b === buckets[0]);
  if (!weekly && buckets[1] && buckets[1] !== buckets[0]) weekly = extractRawBucket((b) => b === buckets[1]);

  return {
    groupName: String(matched?.displayName || 'Model Pool').trim(),
    description: String(matched?.description || ''),
    fiveHour,
    weekly,
  };
}

function indexGenChats(gens) {
  const byRid = new Map();
  const byIdx = new Map();
  for (const g of gens) {
    const chat = g?.chatModel;
    if (!chat) continue;
    const rid = String(chat.usage?.responseId || chat.usage?.messageId || '').trim();
    if (rid) byRid.set(rid, chat);
    if (Array.isArray(g.stepIndices)) {
      for (const idx of g.stepIndices) {
        if (Number.isInteger(idx)) byIdx.set(idx, chat);
      }
    }
  }
  return { byRid, byIdx };
}

/**
 * 统计单个会话轨迹在全生命周期、5 小时窗口与周窗口内的 API 等价美刀消费。
 */
export function analyzeTrajectoryEconomics(
  trajectoryRes,
  userStatusRes,
  { nowMs = Date.now(), fiveHStartMs = null, weeklyStartMs = null, fallbackModelLabel = '', quotaGroupName = '', quotaGroupDesc = '' } = {}
) {
  const metaMap = buildModelMetaMap(userStatusRes);
  const labelMap = buildModelLabelMap(userStatusRes);
  const traj = trajectoryRes?.trajectory || trajectoryRes || {};
  const steps = Array.isArray(traj.steps) ? traj.steps : [];
  const gens = Array.isArray(traj.generatorMetadata) ? traj.generatorMetadata : [];
  const { byRid, byIdx } = indexGenChats(gens);

  let totalTokens = 0;
  let totalUsd = 0;
  let calls = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;

  let groupTotalUsd = 0;
  let window5hUsd = 0;
  let windowWeeklyUsd = 0;
  let groupUnpricedCount = 0;

  let activeRawModel = '';
  let activeModelLabel = fallbackModelLabel || '';
  const seenRids = new Set();
  const byModel = new Map();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const meta = step?.metadata;
    const usage = meta?.modelUsage;
    if (!usage || typeof usage !== 'object') continue;

    const rid = String(usage.responseId || usage.messageId || '').trim();
    if (rid && seenRids.has(rid)) continue;
    if (rid) seenRids.add(rid);
    calls += 1;

    const chat = (rid && byRid.get(rid)) || byIdx.get(i) || null;
    const rawModel = String(usage.model || meta?.generatorModel || chat?.model || meta?.requestedModel || '').trim();
    const resolvedLabel = resolveModelLabel(rawModel, labelMap);

    // 优先取最后一条常规模型响应作为当前活跃模型
    if (rawModel) {
      if (!/CHECKPOINT|COMPACTION/.test(String(step?.type || '')) || !activeRawModel) {
        activeRawModel = rawModel;
        activeModelLabel = resolvedLabel || activeModelLabel;
      }
    }

    const inp = safeInt(usage.inputTokens);
    const cache = safeInt(usage.cacheReadTokens);
    const out = safeInt(usage.outputTokens);
    const stepTokens = inp + cache + out;
    totalTokens += stepTokens;

    const tsMs = Date.parse(meta?.finishedGeneratingAt || meta?.completedAt || meta?.createdAt || '');
    const stepMs = Number.isFinite(tsMs) ? tsMs : nowMs;
    const pricing = resolveModelPricing(rawModel, metaMap);
    const inTargetGroup = !quotaGroupName || belongsToQuotaGroup(quotaGroupDesc, resolvedLabel || pricing.label, quotaGroupName);

    const baseName = stripEffortSuffix(resolvedLabel || pricing.label || 'Unknown Model') || 'Unknown Model';
    if (!byModel.has(baseName)) {
      byModel.set(baseName, { label: baseName, priced: false, usd: 0, tokens: 0, calls: 0 });
    }
    const modelEntry = byModel.get(baseName);
    modelEntry.tokens += stepTokens;
    modelEntry.calls += 1;

    if (pricing.priced) {
      pricedCalls += 1;
      const stepUsd =
        (inp / 1e6) * pricing.inputPerM +
        (cache / 1e6) * pricing.cachePerM +
        (out / 1e6) * pricing.outputPerM;

      totalUsd += stepUsd;
      modelEntry.priced = true;
      modelEntry.usd += stepUsd;

      if (inTargetGroup) {
        groupTotalUsd += stepUsd;
        if (fiveHStartMs !== null && stepMs >= fiveHStartMs) window5hUsd += stepUsd;
        if (weeklyStartMs !== null && stepMs >= weeklyStartMs) windowWeeklyUsd += stepUsd;
      }
    } else {
      unpricedCalls += 1;
      if (inTargetGroup) groupUnpricedCount += 1;
    }
  }

  // 若 steps 中尚无模型记录，尝试从 generatorMetadata 回退识别当前模型
  if (!activeRawModel && gens.length > 0) {
    for (let i = gens.length - 1; i >= 0; i -= 1) {
      const m = String(gens[i]?.chatModel?.model || '').trim();
      if (m) {
        activeRawModel = m;
        activeModelLabel = resolveModelLabel(m, labelMap);
        break;
      }
    }
  }

  const activePricing = resolveModelPricing(activeRawModel || activeModelLabel, metaMap);
  const models = Array.from(byModel.values())
    .map((m) => ({
      label: m.label,
      priced: m.priced,
      usd: +m.usd.toFixed(4),
      tokens: m.tokens,
      calls: m.calls,
    }))
    .sort((a, b) => (b.usd !== a.usd ? b.usd - a.usd : b.tokens - a.tokens));

  return {
    activeModel: {
      rawModel: activeRawModel,
      label: stripEffortSuffix(activeModelLabel || activePricing.label || 'Unknown Model') || 'Unknown Model',
      pricing: activePricing,
    },
    session: {
      calls,
      pricedCalls,
      unpricedCalls,
      totalTokens,
      totalUsd: +totalUsd.toFixed(4),
      models,
    },
    windows: {
      groupTotalUsd,
      window5hUsd,
      windowWeeklyUsd,
      groupUnpricedCount,
    },
  };
}

/** 判断两个模型的配额归属组是否一致（避免拿 Claude 的消费去校准 Gemini 池） */
export function belongsToQuotaGroup(groupDescription, modelLabel, groupName) {
  const desc = String(groupDescription || '').toLowerCase();
  const lbl = stripEffortSuffix(modelLabel).toLowerCase();
  if (lbl && desc && desc.includes(lbl)) return true;
  if (/gemini/i.test(String(groupName || '')) && /gemini/i.test(lbl)) return true;
  if (/claude|gpt/i.test(String(groupName || '')) && /claude|gpt/i.test(lbl)) return true;
  return !desc;
}

function buildHistoricalWindowCapacity(bucket, kind, observedLocalUsd, nowMs) {
  if (!bucket) return null;
  const usedFrac = typeof bucket.usedFrac === 'number' ? bucket.usedFrac : 0;
  const remainingFrac = typeof bucket.remainingFrac === 'number' ? bucket.remainingFrac : 0;

  let poolUsd = null;
  let remainingUsd = null;
  if (observedLocalUsd > 0 && usedFrac > 0.0005) {
    poolUsd = +(observedLocalUsd / usedFrac).toFixed(2);
    remainingUsd = +(poolUsd * remainingFrac).toFixed(2);
  }

  return {
    usedPct: bucket.usedPct,
    remainingPct: bucket.remainingPct,
    resetTime: bucket.resetTime,
    projection: analyzeQuotaWindow(bucket, kind, nowMs),
    observedLocalUsd: +observedLocalUsd.toFixed(2),
    poolUsd,
    remainingUsd,
  };
}

/** 根据现有历史窗口消费与当前已用比例直接推算 5h 与周池子总美刀及剩余美刀（纯美元计价，无单模型推算） */
export function summarizeHistoricalPool({
  targetGroup = null,
  observed5hUsd = 0,
  observedWeeklyUsd = 0,
  nowMs = Date.now(),
} = {}) {
  if (!targetGroup) return null;
  return {
    groupName: targetGroup.groupName,
    fiveHour: buildHistoricalWindowCapacity(targetGroup.fiveHour, '5h', observed5hUsd, nowMs),
    weekly: buildHistoricalWindowCapacity(targetGroup.weekly, 'weekly', observedWeeklyUsd, nowMs),
  };
}
