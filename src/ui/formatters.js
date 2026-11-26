/**
 * DOM 辅助构建器、指标数值格式化与宿主对话路由识别工具。
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 轻量 DOM 创建函数 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'className') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'hidden') el.hidden = Boolean(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c !== null && c !== undefined) el.appendChild(c);
  }
  return el;
}

/** 将 Token 数量格式化为 K / M / B 紧凑字符串 */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 格式化美元金额（如 `$13.94`、`$0.075`、`<$0.01`） */
export function formatUsd(n, decimals = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  if (n > 0 && n < 0.005 && decimals <= 2) return '<$0.01';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(decimals)}`;
}

/** 格式化每百万 Token 美元单价 */
export function formatRateUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  if (n > 0 && n < 0.1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** 格式化时长（秒或分秒） */
export function formatDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '--';
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
  }
  return sec >= 10 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
}

/** 格式化配额重置倒计时 */
export function formatCountdown(isoStr) {
  if (!isoStr) return '--';
  const target = Date.parse(isoStr);
  if (!Number.isFinite(target)) return '--';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Resetting soon';
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${mins}m`;
  return `Resets in ${mins}m`;
}

/** 识别当前界面是否处于对话页，并返回路由中的 cascadeId（非对话页返回 false） */
export function getActiveConversationContext() {
  try {
    const pathname = String(window.location?.pathname || '');
    const m = pathname.match(/^\/c\/([0-9a-f-]{36})(?:\/|$)/i);
    if (m && UUID_RE.test(m[1])) {
      return { inConversation: true, cascadeId: m[1] };
    }
    const views = document.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    for (const v of views) {
      if (v.hasAttribute('hidden')) continue;
      const st = getComputedStyle(v);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = v.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const cid = String(v.getAttribute('data-cascade-id') || '').trim();
        if (UUID_RE.test(cid)) {
          return { inConversation: true, cascadeId: cid };
        }
      }
    }
    return { inConversation: false, cascadeId: '' };
  } catch {
    return { inConversation: false, cascadeId: '' };
  }
}
