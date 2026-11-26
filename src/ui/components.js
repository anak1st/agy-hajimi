/**
 * 顶栏胶囊与悬浮监控卡片 UI 组件与渲染逻辑。
 */

import { formatCountdown, formatDuration, formatTokens, h, SVG_NS } from './formatters.js';

export const RING_RADIUS = 5.8;
export const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

function renderQuotaRow(labelText, winObj) {
  const pct = winObj?.remainingPct;
  const hasPct = typeof pct === 'number' && Number.isFinite(pct);
  const toneClass = !hasPct ? '' : pct < 20 ? 'tone-danger' : pct < 50 ? 'tone-warn' : 'tone-ok';
  const fill = h('div', { className: `hud-progress-fill ${toneClass}` });
  fill.style.width = `${hasPct ? Math.max(0, Math.min(100, pct)) : 0}%`;

  const proj = winObj?.projection;
  const toneSuffix = proj?.tone && proj.tone !== 'muted' ? ` tone-${proj.tone}` : '';
  const paceEl = proj
    ? h('div', { className: 'hud-quota-pace' }, [
        h('span', { className: 'hud-quota-est', text: proj.paceText }),
        h('span', {
          className: `hud-quota-proj${toneSuffix}`,
          text: proj.estPctText,
        }),
      ])
    : null;

  return h('div', { className: 'hud-quota-row' }, [
    h('div', { className: 'hud-quota-row-head' }, [
      h('span', { className: 'hud-quota-win', text: labelText }),
      h('span', {
        className: 'hud-quota-meta',
        text: hasPct ? `${pct.toFixed(1)}% left · ${formatCountdown(winObj.resetTime)}` : 'Unavailable',
      }),
    ]),
    h('div', { className: 'hud-progress-track' }, [fill]),
    paceEl,
  ]);
}

function createRefreshIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const p1 = document.createElementNS(SVG_NS, 'path');
  p1.setAttribute('d', 'M13.5 8a5.5 5.5 0 1 1-1.4-3.7');
  const p2 = document.createElementNS(SVG_NS, 'path');
  p2.setAttribute('d', 'M13.5 2.5v3h-3');
  svg.appendChild(p1);
  svg.appendChild(p2);
  return svg;
}

/** 创建顶栏胶囊 DOM 与悬浮卡片各数据区块 */
export function createHudViews({
  initialTelemetry = null,
  initialQuotaPools = [],
  onTogglePopover,
  onForceRefresh,
  onPositionPopover,
}) {
  let popoverOpen = false;
  let lastTelemetry = initialTelemetry;
  let lastValidQuotaPools = Array.isArray(initialQuotaPools) ? initialQuotaPools : [];

  // 1. 顶栏胶囊
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 16 16');
  ringSvg.setAttribute('class', 'hud-ring-svg');
  ringSvg.setAttribute('aria-hidden', 'true');

  const ringTrack = document.createElementNS(SVG_NS, 'circle');
  ringTrack.setAttribute('cx', '8');
  ringTrack.setAttribute('cy', '8');
  ringTrack.setAttribute('r', String(RING_RADIUS));
  ringTrack.setAttribute('class', 'hud-ring-track');

  const ringFill = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('cx', '8');
  ringFill.setAttribute('cy', '8');
  ringFill.setAttribute('r', String(RING_RADIUS));
  ringFill.setAttribute('class', 'hud-ring-fill is-empty');
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

  const capPctEl = h('span', { className: 'hud-cap-pct', text: 'Loading' });
  const capsuleBtn = h(
    'button',
    {
      type: 'button',
      className: 'hud-capsule-btn is-loading',
      title: 'Context HUD (Click for details, Right-click to refresh)',
      'aria-label': 'Context Window HUD',
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        onTogglePopover(!popoverOpen);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        onForceRefresh();
      },
    },
    [ringSvg, capPctEl]
  );

  // 2. 悬浮卡片顶栏
  const appTitleEl = h('span', { className: 'hud-app-title', text: 'Antigravity Hajimi' });
  const sshBadgeEl = h('span', { className: 'hud-ssh-badge', hidden: true, text: 'SSH' });
  const updatedTimeEl = h('span', { className: 'hud-updated-at', text: '--:--:--' });
  const refreshBtn = h(
    'button',
    {
      type: 'button',
      className: 'hud-icon-btn',
      title: 'Refresh now',
      'aria-label': 'Refresh telemetry',
      onClick: () => onForceRefresh(),
    },
    [createRefreshIcon()]
  );

  // 3. Context Window 卡片
  const ctxRatioEl = h('span', { className: 'hud-ctx-ratio', text: '-- / --' });
  const ctxPctEl = h('span', { className: 'hud-ctx-pct', text: '--%' });
  const ctxFillEl = h('div', { className: 'hud-progress-fill' });
  const ctxRemainingEl = h('span', { text: 'Remaining: --' });
  const ctxCompactionsEl = h('span', { text: 'Compactions: 0' });
  const ctxCardEl = h('section', { className: 'hud-card' }, [
    h('div', { className: 'hud-card-head' }, [
      h('span', { className: 'hud-card-title', text: 'Context Window' }),
    ]),
    h('div', { className: 'hud-ctx-hero' }, [ctxRatioEl, ctxPctEl]),
    h('div', { className: 'hud-progress-track' }, [ctxFillEl]),
    h('div', { className: 'hud-ctx-foot' }, [ctxRemainingEl, ctxCompactionsEl]),
  ]);

  // 4. 2x2 性能指标矩阵（平均值居主位，最新值居次位）
  const cellSpeedVal = h('strong', { className: 'hud-cell-val', text: '--' });
  const cellSpeedSub = h('span', { className: 'hud-cell-sub', text: 'Latest --' });
  const cellTtftVal = h('strong', { className: 'hud-cell-val', text: '--' });
  const cellTtftSub = h('span', { className: 'hud-cell-sub', text: 'Latest --' });
  const cellCacheVal = h('strong', { className: 'hud-cell-val', text: '--' });
  const cellCacheSub = h('span', { className: 'hud-cell-sub', text: 'Latest --' });
  const cellTotalVal = h('strong', { className: 'hud-cell-val', text: '--' });
  const cellTotalSub = h('span', { className: 'hud-cell-sub', text: '0 steps · 0 calls' });

  const matrixEl = h('section', { className: 'hud-matrix' }, [
    h('div', { className: 'hud-metric-cell' }, [
      h('span', { className: 'hud-cell-label', text: 'Avg Speed' }),
      cellSpeedVal,
      cellSpeedSub,
    ]),
    h('div', { className: 'hud-metric-cell' }, [
      h('span', { className: 'hud-cell-label', text: 'Avg First Token (TTFT)' }),
      cellTtftVal,
      cellTtftSub,
    ]),
    h('div', { className: 'hud-metric-cell' }, [
      h('span', { className: 'hud-cell-label', text: 'Avg Cache Hit Rate' }),
      cellCacheVal,
      cellCacheSub,
    ]),
    h('div', { className: 'hud-metric-cell' }, [
      h('span', { className: 'hud-cell-label', text: 'Session Tokens' }),
      cellTotalVal,
      cellTotalSub,
    ]),
  ]);

  // 5. Token Usage 扁平 3 列
  const tokInputVal = h('span', { className: 'hud-token-col-val', text: '--' });
  const tokCacheVal = h('span', { className: 'hud-token-col-val', text: '--' });
  const tokOutputVal = h('span', { className: 'hud-token-col-val', text: '--' });
  const tokensCardEl = h('section', { className: 'hud-card' }, [
    h('div', { className: 'hud-card-head' }, [
      h('span', { className: 'hud-card-title', text: 'Token Usage' }),
    ]),
    h('div', { className: 'hud-token-grid' }, [
      h('div', { className: 'hud-token-col' }, [
        h('span', { className: 'hud-token-col-label', text: 'Uncached Input' }),
        tokInputVal,
      ]),
      h('div', { className: 'hud-token-col' }, [
        h('span', { className: 'hud-token-col-label', text: 'Cache Read' }),
        tokCacheVal,
      ]),
      h('div', { className: 'hud-token-col' }, [
        h('span', { className: 'hud-token-col-label', text: 'Output' }),
        tokOutputVal,
      ]),
    ]),
  ]);

  // 6. Model Quotas（仅 Gemini 系列，跨会话独立缓存）
  const quotaListEl = h('div', { className: 'hud-quota-list' });
  const quotaCardEl = h('section', { className: 'hud-card' }, [
    h('div', { className: 'hud-card-head' }, [
      h('span', { className: 'hud-card-title', text: 'Model Quotas' }),
    ]),
    quotaListEl,
  ]);

  const popoverEl = h(
    'div',
    {
      className: 'hud-popover',
      role: 'dialog',
      'aria-label': 'Context HUD Details',
      hidden: true,
    },
    [
      h('header', { className: 'hud-topbar' }, [
        appTitleEl,
        h('div', { className: 'hud-header-right' }, [sshBadgeEl, updatedTimeEl, refreshBtn]),
      ]),
      h('div', { className: 'hud-body' }, [ctxCardEl, matrixEl, tokensCardEl, quotaCardEl]),
    ]
  );

  function renderQuotaSection(pools, emptyText) {
    if (!Array.isArray(pools) || pools.length === 0) {
      quotaListEl.replaceChildren(h('div', { className: 'hud-empty', text: emptyText }));
      return;
    }
    quotaListEl.replaceChildren(
      ...pools.map((pool) => {
        const rows = [];
        if (pool.fiveHour) rows.push(renderQuotaRow('5-Hour Limit', pool.fiveHour));
        if (pool.weekly) rows.push(renderQuotaRow('Weekly Limit', pool.weekly));
        return h('div', { className: 'hud-quota-pool' }, rows);
      })
    );
  }

  function renderTelemetry(data, errMsg = '') {
    if (data !== null) {
      lastTelemetry = data;
      const rawPools = Array.isArray(data?.quotas?.pools) ? data.quotas.pools : [];
      const freshPools = rawPools.filter((p) => /gemini/i.test(String(p?.name || '')));
      if (freshPools.length > 0) {
        lastValidQuotaPools = freshPools;
      }
    } else {
      lastTelemetry = null;
    }

    const d = lastTelemetry;
    if (!d) {
      capsuleBtn.classList.add('is-loading');
      ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
      ringFill.className.baseVal = 'hud-ring-fill is-empty';
      capPctEl.textContent = errMsg ? 'Offline' : 'Loading';
      capPctEl.className = 'hud-cap-pct';
      if (popoverOpen) {
        sshBadgeEl.hidden = true;
        ctxRatioEl.textContent = '-- / --';
        ctxPctEl.textContent = '--%';
        ctxPctEl.className = 'hud-ctx-pct';
        ctxFillEl.className = 'hud-progress-fill';
        ctxFillEl.style.width = '0%';
        ctxRemainingEl.textContent = 'Remaining: --';
        ctxCompactionsEl.textContent = 'Compactions: 0';
        cellSpeedVal.textContent = '--';
        cellSpeedSub.textContent = 'Latest --';
        cellTtftVal.textContent = '--';
        cellTtftSub.textContent = 'Latest --';
        cellCacheVal.textContent = '--';
        cellCacheSub.textContent = 'Latest --';
        cellTotalVal.textContent = '--';
        cellTotalSub.textContent = '0 steps · 0 calls';
        tokInputVal.textContent = '--';
        tokCacheVal.textContent = '--';
        tokOutputVal.textContent = '--';
        renderQuotaSection(lastValidQuotaPools, errMsg ? `Disconnected: ${errMsg}` : 'Loading');
        updatedTimeEl.textContent = '--:--:--';
      }
      return;
    }

    capsuleBtn.classList.remove('is-loading');
    const ctx = d.context || {};
    const pct = typeof ctx.usedPct === 'number' && Number.isFinite(ctx.usedPct) ? ctx.usedPct : null;
    const isDanger = pct !== null && pct >= 88;
    const isWarn = pct !== null && !isDanger && pct >= 70;
    const tone = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';

    if (pct === null) {
      ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
      ringFill.className.baseVal = 'hud-ring-fill is-empty';
      capPctEl.textContent = '--%';
      capPctEl.className = 'hud-cap-pct';
    } else {
      const offset = +(RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, pct)) / 100)).toFixed(2);
      ringFill.setAttribute('stroke-dashoffset', String(offset));
      ringFill.className.baseVal = `hud-ring-fill${tone ? ` ${tone}` : ''}`;
      capPctEl.textContent = `${Math.round(pct)}%`;
      capPctEl.className = `hud-cap-pct${tone ? ` ${tone}` : ''}`;
    }

    if (!popoverOpen) return;

    const active = d.activeConversation;
    sshBadgeEl.hidden = !d.endpoint?.isRemote;
    sshBadgeEl.textContent = d.endpoint?.label || 'SSH';

    if (ctx.usedTokens !== null && ctx.maxTokens !== null && ctx.maxTokens > 0) {
      ctxRatioEl.textContent = `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.maxTokens)}`;
      ctxPctEl.textContent = `${pct.toFixed(1)}%`;
      ctxPctEl.className = `hud-ctx-pct${tone ? ` ${tone}` : ''}`;
      ctxFillEl.className = `hud-progress-fill${tone ? ` ${tone}` : ''}`;
      ctxFillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      ctxRemainingEl.textContent = `Remaining: ${formatTokens(ctx.remainingTokens)} tokens`;
    } else {
      ctxRatioEl.textContent = '-- / --';
      ctxPctEl.textContent = '--%';
      ctxPctEl.className = 'hud-ctx-pct';
      ctxFillEl.className = 'hud-progress-fill';
      ctxFillEl.style.width = '0%';
      ctxRemainingEl.textContent = 'Remaining: --';
    }
    ctxCompactionsEl.textContent = `Compactions: ${Number(ctx.compactions || 0)}`;

    const perf = d.performance || {};
    cellSpeedVal.textContent = perf.avgTps !== null ? `${perf.avgTps} tok/s` : '--';
    cellSpeedSub.textContent = `Latest ${perf.latestTps !== null ? `${perf.latestTps} tok/s` : '--'}`;
    cellTtftVal.textContent = perf.avgTtftSec !== null ? formatDuration(perf.avgTtftSec) : '--';
    cellTtftSub.textContent = `Latest ${perf.latestTtftSec !== null ? formatDuration(perf.latestTtftSec) : '--'}`;
    cellCacheVal.textContent = perf.sessionCacheHitPct !== null ? `${perf.sessionCacheHitPct}%` : '--';
    cellCacheSub.textContent = `Latest ${perf.latestCacheHitPct !== null ? `${perf.latestCacheHitPct}%` : '--'}`;

    const tok = d.tokens || {};
    cellTotalVal.textContent = formatTokens(tok.totalTokens || 0);
    cellTotalSub.textContent = `${active?.stepCount ?? 0} steps · ${perf.modelCalls ?? 0} calls`;

    tokInputVal.textContent = formatTokens(tok.inputTokens || 0);
    tokCacheVal.textContent = formatTokens(tok.cacheReadTokens || 0);
    tokOutputVal.textContent = formatTokens(tok.outputTokens || 0);

    const rawPools = Array.isArray(d?.quotas?.pools) ? d.quotas.pools : [];
    const freshPools = rawPools.filter((p) => /gemini/i.test(String(p?.name || '')));
    renderQuotaSection(freshPools.length > 0 ? freshPools : lastValidQuotaPools, 'Quota data unavailable');

    updatedTimeEl.textContent = new Date(d.timestampMs || Date.now()).toLocaleTimeString('en-US', { hour12: false });
  }

  function setPopoverOpen(next) {
    popoverOpen = Boolean(next);
    capsuleBtn.classList.toggle('is-open', popoverOpen);
    capsuleBtn.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
    popoverEl.hidden = !popoverOpen;
    if (popoverOpen) {
      renderTelemetry(lastTelemetry);
      onPositionPopover();
      requestAnimationFrame(() => onPositionPopover());
    }
  }

  return {
    capsuleBtn,
    popoverEl,
    isOpen: () => popoverOpen,
    setPopoverOpen,
    renderTelemetry,
    getLastTelemetry: () => lastTelemetry,
    getLastQuotaPools: () => lastValidQuotaPools,
  };
}
