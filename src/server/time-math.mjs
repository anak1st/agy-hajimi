/**
 * 时间与数值解析工具（使用 BigInt 纳秒时间戳避免 0.5s 阈值附近的浮点舍入误差）。
 */

/** 解析形如 `"1.25s"` 的时长字符串为秒数 */
export function parseDurationSec(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 将 ISO-8601 时间戳（最高支持纳秒 9 位小数）精确解析为 BigInt 纳秒数 */
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

/** 使用 BigInt 纳秒差值计算两个 ISO 时间戳之间的秒数 */
export function computeDurationSec(startIso, endIso) {
  const s = parseIsoNs(startIso);
  const e = parseIsoNs(endIso);
  if (s === null || e === null || e <= s) return null;
  return Number(e - s) / 1e9;
}

/** 将数字或纯数字字符串安全转换为非负整数 */
export function safeInt(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 0 ? Math.floor(val) : 0;
  }
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const n = Number(val.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }
  return 0;
}
