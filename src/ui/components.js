/**
 * 顶栏胶囊与悬浮监控卡片 UI 组件与渲染逻辑。
 */

import { formatCountdown, formatDuration, formatTokens, formatUsd, h, SVG_NS } from './formatters.js';

export const RING_RADIUS = 5.8;
export const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

function renderMergedQuotaRow(labelText, winObj, fallbackWinObj = null) {
  const effectiveWin = winObj || fallbackWinObj;
  const remPct = effectiveWin?.remainingPct;
  const hasPct = typeof remPct === 'number' && Number.isFinite(remPct);
  const toneClass = !hasPct ? '' : remPct < 20 ? 'tone-danger' : remPct < 50 ? 'tone-warn' : 'tone-ok';
  const fill = h('div', { className: `hud-progress-fill ${toneClass}` });
  fill.style.width = `${hasPct ? Math.max(0, Math.min(100, remPct)) : 0}%`;

  const proj = winObj?.projection || fallbackWinObj?.projection;
  const toneSuffix = proj?.tone && proj.tone !== 'muted' ? ` tone-${proj.tone}` : '';
  let rightProjNode = null;
  if (proj) {
    const rawEst = String(proj.estPctText || '');
    const match = rawEst.match(/^(Estimated\s+)(.+)$/);
    rightProjNode = match
      ? h('span', { className: 'hud-quota-est' }, [
          document.createTextNode(match[1]),
          h('span', { className: `hud-quota-proj${toneSuffix}`, text: match[2] }),
        ])
      : h('span', { className: `hud-quota-proj${toneSuffix}`, text: rawEst });
  }
  const paceEl = proj
    ? h('div', { className: 'hud-quota-pace' }, [
        h('span', { className: 'hud-quota-est', text: proj.paceText }),
        rightProjNode,
      ])
    : null;

  const hasPoolUsd = winObj?.poolUsd !== null && winObj?.poolUsd !== undefined;
  const hasSpent = winObj?.observedLocalUsd !== null && winObj?.observedLocalUsd !== undefined;
  const usdRow = h('div', { className: 'hud-quota-pace' }, [
    h('span', {
      className: 'hud-quota-est',
      text: hasSpent ? `Spent: ${formatUsd(winObj.observedLocalUsd)}` : 'Spent: --',
    }),
    h('span', {
      className: 'hud-quota-est',
      text: hasPoolUsd ? `Total: ${formatUsd(winObj.poolUsd)}` : 'Total: --',
    }),
  ]);

  return h('div', { className: 'hud-quota-row' }, [
    h('div', { className: 'hud-quota-row-head' }, [
      h('span', { className: 'hud-quota-win', text: labelText }),
      h('span', {
        className: 'hud-quota-meta',
        text: hasPct ? `${remPct.toFixed(1)}% left · ${formatCountdown(effectiveWin.resetTime)}` : 'Unavailable',
      }),
    ]),
    h('div', { className: 'hud-progress-track' }, [fill]),
    paceEl,
    usdRow,
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
  initialTab = 'overview',
  onTogglePopover,
  onForceRefresh,
  onPositionPopover,
}) {
  let popoverOpen = false;
  let activeTab = initialTab === 'quota-math' ? 'quota-math' : 'overview';
  let lastTelemetry = initialTelemetry;
  let lastValidCalibration = initialTelemetry?.economics?.calibration || null;
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

  // 2. 悬浮卡片顶栏（无标题，改为双 Tab）
  const tabOverviewBtn = h('button', {
    type: 'button',
    role: 'tab',
    className: 'hud-tab-btn',
    text: 'Session',
    'aria-selected': 'true',
    onClick: () => setActiveTab('overview'),
  });
  const tabMathBtn = h('button', {
    type: 'button',
    role: 'tab',
    className: 'hud-tab-btn',
    text: 'Quotas',
    'aria-selected': 'false',
    onClick: () => setActiveTab('quota-math'),
  });
  const tabsEl = h('div', { className: 'hud-tabs', role: 'tablist' }, [tabOverviewBtn, tabMathBtn]);
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

  const overviewBodyEl = h('div', { className: 'hud-body' }, [ctxCardEl, matrixEl, tokensCardEl]);

  // 6. 第二页：Quotas（总美元 + 模型使用明细列表 + Model Quotas）
  const mathSessTotalUsdEl = h('span', { className: 'hud-ctx-ratio', text: '--' });
  const mathModelListEl = h('div', { className: 'hud-model-list' });

  const mathSessionCardEl = h('section', { className: 'hud-card' }, [
    h('div', { className: 'hud-card-head' }, [
      h('span', { className: 'hud-card-title', text: 'Usage Cost' }),
      mathSessTotalUsdEl,
    ]),
    mathModelListEl,
  ]);

  const mathCalibStatusEl = h('span', { className: 'hud-card-aside', text: '--' });
  const mathPoolsEl = h('div', { className: 'hud-quota-list' });
  const mathCalibCardEl = h('section', { className: 'hud-card' }, [
    h('div', { className: 'hud-card-head' }, [
      h('span', { className: 'hud-card-title', text: 'Model Quotas' }),
      mathCalibStatusEl,
    ]),
    mathPoolsEl,
  ]);

  const mathBodyEl = h('div', { className: 'hud-body', hidden: true }, [
    mathSessionCardEl,
    mathCalibCardEl,
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
        tabsEl,
        h('div', { className: 'hud-header-right' }, [sshBadgeEl, updatedTimeEl, refreshBtn]),
      ]),
      overviewBodyEl,
      mathBodyEl,
    ]
  );

  function syncTabUi() {
    const isMath = activeTab === 'quota-math';
    tabOverviewBtn.classList.toggle('is-active', !isMath);
    tabOverviewBtn.setAttribute('aria-selected', !isMath ? 'true' : 'false');
    tabMathBtn.classList.toggle('is-active', isMath);
    tabMathBtn.setAttribute('aria-selected', isMath ? 'true' : 'false');
    overviewBodyEl.hidden = isMath;
    mathBodyEl.hidden = !isMath;
  }

  function setActiveTab(nextTab) {
    activeTab = nextTab === 'quota-math' ? 'quota-math' : 'overview';
    syncTabUi();
    if (popoverOpen) {
      renderTelemetry(lastTelemetry);
      onPositionPopover();
      requestAnimationFrame(() => onPositionPopover());
    }
  }
  syncTabUi();

  function renderQuotaMathPools(cal, fallbackPools, emptyText) {
    const fbPool = Array.isArray(fallbackPools) && fallbackPools.length > 0 ? fallbackPools[0] : null;
    const fiveHourWin = cal?.fiveHour || null;
    const weeklyWin = cal?.weekly || null;
    const fbFiveHour = fbPool?.fiveHour || null;
    const fbWeekly = fbPool?.weekly || null;

    if (!fiveHourWin && !weeklyWin && !fbFiveHour && !fbWeekly) {
      mathCalibStatusEl.textContent = emptyText === 'Loading' ? '--' : 'Unavailable';
      mathPoolsEl.replaceChildren(h('div', { className: 'hud-empty', text: emptyText }));
      return;
    }
    mathCalibStatusEl.textContent = cal?.groupName || fbPool?.name || 'Quota';
    const poolRows = [];
    if (fiveHourWin || fbFiveHour) poolRows.push(renderMergedQuotaRow('5-Hour Limit', fiveHourWin, fbFiveHour));
    if (weeklyWin || fbWeekly) poolRows.push(renderMergedQuotaRow('Weekly Limit', weeklyWin, fbWeekly));
    mathPoolsEl.replaceChildren(...poolRows);
  }

  function renderQuotaMathSection(economics, fallbackPools, emptyText) {
    const sess = economics?.session || null;
    const cal = economics?.calibration || lastValidCalibration;

    if (!sess) {
      mathSessTotalUsdEl.textContent = '--';
      mathModelListEl.replaceChildren(h('div', { className: 'hud-empty', text: emptyText || 'Loading' }));
      renderQuotaMathPools(lastValidCalibration, fallbackPools, emptyText || 'Loading');
      return;
    }

    mathSessTotalUsdEl.textContent = sess.pricedCalls > 0 ? formatUsd(sess.totalUsd) : '--';
    const models = Array.isArray(sess.models) ? sess.models : [];
    if (models.length === 0) {
      mathModelListEl.replaceChildren(h('div', { className: 'hud-model-empty', text: 'No model usage yet' }));
    } else {
      mathModelListEl.replaceChildren(
        ...models.map((m) =>
          h('div', { className: 'hud-model-row' }, [
            h('span', { className: 'hud-model-name', text: m.label }),
            h('span', {
              className: 'hud-model-stats',
              text: `${m.priced ? formatUsd(m.usd) : '--'} · ${formatTokens(m.tokens)}`,
            }),
          ])
        )
      );
    }

    renderQuotaMathPools(cal, fallbackPools, 'Quota data unavailable');
  }

  function renderTelemetry(data, errMsg = '') {
    if (data !== null) {
      lastTelemetry = data;
      if (data?.economics?.calibration && (data.economics.calibration.fiveHour || data.economics.calibration.weekly)) {
        lastValidCalibration = data.economics.calibration;
      }
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
        renderQuotaMathSection(null, lastValidQuotaPools, errMsg ? `Disconnected: ${errMsg}` : 'Loading');
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
    renderQuotaMathSection(d.economics || null, freshPools.length > 0 ? freshPools : lastValidQuotaPools, 'Quota data unavailable');

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
    getActiveTab: () => activeTab,
    setActiveTab,
    renderTelemetry,
    getLastTelemetry: () => lastTelemetry,
    getLastQuotaPools: () => lastValidQuotaPools,
  };
}
