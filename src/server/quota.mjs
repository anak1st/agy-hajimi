/**
 * 模型名称映射与 Gemini 系列模型配额归一化模块。
 */

/** 从 GetUserStatus 响应中提取模型 ID -> 可读显示名称映射表 */
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

/** 将内部模型代号解析为展示名称 */
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

/** 归一化单个配额窗口（5 小时 / 每周）的剩余与已用比例 */
export function normalizeQuotaWindow(bucket, nowMs = Date.now()) {
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

/** 解析并仅保留 Gemini 系列模型的配额池 */
export function normalizeQuotas(quotaRes, userStatusRes) {
  const payload = quotaRes?.response !== undefined ? quotaRes.response : quotaRes;
  const rawGroups = Array.isArray(payload?.groups) ? payload.groups : [];
  const nowMs = Date.now();
  const pools = [];

  for (const grp of rawGroups) {
    const name = String(grp?.displayName || 'Model Pool').trim();
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
