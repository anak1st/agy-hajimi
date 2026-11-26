/**
 * Antigravity App Context HUD 注入端脚本（双 Shadow Host 架构）
 *
 * 1. #ag-ctx-hud-capsule：挂载于顶栏右侧按钮组（[class*="@container/titlebar"] > div.shrink-0），
 *    展示圆形 SVG 进度条 + 上下文占用百分比；
 * 2. #ag-ctx-hud-portal：挂载于 document.body 顶层，点击胶囊时弹出信息丰富的悬浮卡片；
 * 3. 通过 CDP Runtime.addBinding 与后台 daemon 双向通信，不占用额外 HTTP 端口。
 */
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const CAPSULE_ID = 'ag-ctx-hud-capsule';
  const PORTAL_ID = 'ag-ctx-hud-portal';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RING_RADIUS = 5.8;
  const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const IDLE_POLL_MS = 10 * 60 * 1000; // 空闲时 10 分钟拉取一次
  const RUNNING_POLL_MS = 10 * 1000;   // 生成中每 10 秒拉取一次

  // 若已有旧实例，先安全清理卸载（支持代码热更新）
  let carryOpen = false;
  let carryTelemetry = null;
  try {
    const prev = window.__agCtxHudOverlay;
    if (prev) {
      carryOpen = Boolean(prev.isOpen?.());
      carryTelemetry = prev.getTelemetry?.() || null;
      prev.dispose?.();
    }
  } catch {}
  document.getElementById(CAPSULE_ID)?.remove();
  document.getElementById(PORTAL_ID)?.remove();

  const cfg = window.__agCtxHudConfig || {};
  const bindingName = String(cfg.binding || '__agCtxHudCallV1');
  const bundleVersion = String(cfg.bundleVersion || '1.0.0');
  const stylesCss = String(cfg.stylesCss || '');

  // --- 1. CDP Binding RPC 客户端 ---
  let reqSeq = 0;
  const pendingRpcs = new Map();

  window.__agCtxHudResolve = (id, payload) => {
    const entry = pendingRpcs.get(id);
    if (!entry) return;
    pendingRpcs.delete(id);
    clearTimeout(entry.timer);
    if (payload && payload.ok) {
      entry.resolve(payload.data);
    } else {
      entry.reject(new Error(payload?.error || 'Request failed'));
    }
  };

  function callBackend(action, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const fn = window[bindingName];
      if (typeof fn !== 'function') {
        reject(new Error('CDP bridge binding unavailable'));
        return;
      }
      const id = ++reqSeq;
      const timer = setTimeout(() => {
        pendingRpcs.delete(id);
        reject(new Error('Bridge request timeout'));
      }, timeoutMs);
      pendingRpcs.set(id, { resolve, reject, timer });
      try {
        fn(JSON.stringify({ id, action, params }));
      } catch (err) {
        pendingRpcs.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // --- 2. 格式化与工具函数 ---
  function h(tag, props = {}, children = []) {
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

  function formatTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function formatDuration(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec)) return '--';
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return `${m}m ${s}s`;
    }
    return sec >= 10 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
  }

  function formatCountdown(isoStr) {
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

  function getActiveConversationContext() {
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

  function extractHostRouteCascadeId() {
    return getActiveConversationContext().cascadeId;
  }

  // --- 3. 主题亮暗极性同步 ---
  function parseColorLuminance(cssColor) {
    const str = String(cssColor || '').trim();
    if (!str) return null;
    const probe = document.createElement('span');
    probe.style.color = str;
    probe.style.display = 'none';
    document.body?.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const m = computed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (!m) return null;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function detectDarkScheme() {
    const html = document.documentElement;
    const cls = `${html?.className || ''} ${document.body?.className || ''}`.toLowerCase();
    const dataTheme = String(html?.getAttribute('data-theme') || '').toLowerCase();
    if (dataTheme.includes('dark') || /\bdark\b/.test(cls)) return true;
    if (dataTheme.includes('light') || /\blight\b/.test(cls)) return false;
    const bg = getComputedStyle(html).getPropertyValue('--background') || getComputedStyle(document.body).backgroundColor;
    const lum = parseColorLuminance(bg);
    return lum !== null ? lum < 0.5 : false;
  }

  function attachStyles(shadowRoot) {
    if (!stylesCss) return;
    if (typeof CSSStyleSheet === 'function' && Array.isArray(shadowRoot.adoptedStyleSheets)) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(stylesCss);
        shadowRoot.adoptedStyleSheets = [sheet];
        return;
      } catch {}
    }
    const styleEl = document.createElement('style');
    styleEl.textContent = stylesCss;
    shadowRoot.appendChild(styleEl);
  }

  // --- 4. 创建双 Shadow Host ---
  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_ID;
  capsuleHost.className = 'hud-capsule-host';
  capsuleHost.setAttribute('data-dock', 'fixed');
  capsuleHost.addEventListener('mousedown', (e) => e.stopPropagation());
  capsuleHost.addEventListener('click', (e) => e.stopPropagation());
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });
  attachStyles(capsuleShadow);

  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_ID;
  portalHost.className = 'hud-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });
  attachStyles(portalShadow);

  function syncThemeScheme() {
    const scheme = detectDarkScheme() ? 'dark' : 'light';
    capsuleHost.setAttribute('data-color-scheme', scheme);
    portalHost.setAttribute('data-color-scheme', scheme);
  }
  syncThemeScheme();

  // --- 5. 构建顶栏胶囊 DOM（圆形进度条 + 上下文百分比） ---
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

  let popoverOpen = false;
  let lastTelemetry = carryTelemetry;
  let lastHostRouteId = extractHostRouteCascadeId();
  let disposed = false;
  let refreshInFlight = false;

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
        setPopoverOpen(!popoverOpen);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void refreshTelemetry(true);
      },
    },
    [ringSvg, capPctEl]
  );
  capsuleShadow.appendChild(capsuleBtn);

  // --- 6. 构建悬浮卡片 DOM ---
  const sshBadgeEl = h('span', { className: 'hud-ssh-badge', hidden: true, text: 'SSH' });

  const refreshIconSvg = document.createElementNS(SVG_NS, 'svg');
  refreshIconSvg.setAttribute('viewBox', '0 0 16 16');
  refreshIconSvg.setAttribute('width', '13');
  refreshIconSvg.setAttribute('height', '13');
  refreshIconSvg.setAttribute('fill', 'none');
  refreshIconSvg.setAttribute('stroke', 'currentColor');
  refreshIconSvg.setAttribute('stroke-width', '1.6');
  refreshIconSvg.setAttribute('stroke-linecap', 'round');
  refreshIconSvg.setAttribute('stroke-linejoin', 'round');
  const p1 = document.createElementNS(SVG_NS, 'path');
  p1.setAttribute('d', 'M13.5 8a5.5 5.5 0 1 1-1.4-3.7');
  const p2 = document.createElementNS(SVG_NS, 'path');
  p2.setAttribute('d', 'M13.5 2.5v3h-3');
  refreshIconSvg.appendChild(p1);
  refreshIconSvg.appendChild(p2);

  const refreshBtn = h(
    'button',
    {
      type: 'button',
      className: 'hud-icon-btn',
      title: 'Refresh now',
      'aria-label': 'Refresh telemetry',
      onClick: () => void refreshTelemetry(true),
    },
    [refreshIconSvg]
  );

  const appTitleEl = h('span', { className: 'hud-app-title', text: 'Antigravity Hajimi' });
  const updatedTimeEl = h('span', { className: 'hud-updated-at', text: '--:--:--' });

  // Overview 视图节点（上下文窗口：仅大小/总大小 + 进度条）
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

  // 2x2 性能指标矩阵（平均值居主位，最新值居次位）
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

  // Token 消耗 3 列明细（仅标题与数值）
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

  // 配额池卡片
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
      h('div', { className: 'hud-body' }, [
        ctxCardEl,
        matrixEl,
        tokensCardEl,
        quotaCardEl,
      ]),
    ]
  );
  portalShadow.appendChild(popoverEl);

  // --- 7. 顶栏停靠与浮层防溢出定位（基于右上角按钮组真实包围盒留出明确间距） ---
  function measureTopRightCluster(vw) {
    const boxes = [];
    const seen = new Set();
    const candidates = document.querySelectorAll(
      '[data-testid="toggle-aux-sidebar"], div.absolute.right-0.top-0 button, div.absolute.right-0.top-0 [role="button"], [class*="@container/titlebar"] button, [class*="@container/titlebar"] a, [class*="@container/titlebar"] [role="button"], header button, button, a, [role="button"]'
    );
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (capsuleHost.contains(el) || portalHost.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 12 || r.height < 12 || r.width > 320) continue;
      if (r.top < 0 || r.top > 40 || r.bottom > 56) continue;
      if (r.right <= vw * 0.45 || r.right > vw + 2) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
      boxes.push({ left: r.left, top: r.top, right: r.right, height: r.height });
    }

    if (boxes.length === 0) return null;
    boxes.sort((a, b) => b.right - a.right);

    // 从最右侧可见按钮向左合并连续按钮组（间距 <= 56px 视为同一组，跨过中间拖拽留白即停止）
    let clusterLeft = boxes[0].left;
    const anchorTop = boxes[0].top;
    const anchorHeight = boxes[0].height;
    let detectedGap = null;
    for (let i = 1; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (b.right >= clusterLeft - 56) {
        const gap = Math.round(clusterLeft - b.right);
        if (gap >= 2 && gap <= 24 && (detectedGap === null || gap < detectedGap)) {
          detectedGap = gap;
        }
        if (b.left < clusterLeft) clusterLeft = b.left;
      } else {
        break;
      }
    }
    const clusterGap = detectedGap ?? 6;
    return { clusterLeft, anchorTop, anchorHeight, clusterGap };
  }

  function updateFixedPosition() {
    const vw = Number(window.innerWidth || 1280);
    const cluster = measureTopRightCluster(vw);
    let topOffset = 8;
    let rightOffset = 18;
    let btnHeight = 28;
    if (cluster) {
      btnHeight = Math.max(24, Math.min(34, Math.round(cluster.anchorHeight || 28)));
      topOffset = Math.max(2, Math.round(cluster.anchorTop + (cluster.anchorHeight - btnHeight) / 2));
      rightOffset = Math.max(12, Math.ceil(vw - cluster.clusterLeft + cluster.clusterGap));
    }
    capsuleHost.style.top = `${topOffset}px`;
    capsuleHost.style.right = `${rightOffset}px`;
    capsuleHost.style.height = `${btnHeight}px`;
    capsuleBtn.style.height = `${btnHeight}px`;
  }

  function ensureDocked() {
    if (disposed) return false;
    const body = document.body || document.documentElement;
    if (!body) return false;
    if (!portalHost.isConnected) body.appendChild(portalHost);

    const ctx = getActiveConversationContext();
    const shouldShow = ctx.inConversation;
    if (capsuleHost.hidden !== !shouldShow) {
      capsuleHost.hidden = !shouldShow;
    }
    if (!shouldShow && popoverOpen) {
      setPopoverOpen(false);
    }

    if (capsuleHost.parentElement !== body) {
      body.appendChild(capsuleHost);
    }
    if (capsuleHost.getAttribute('data-dock') !== 'fixed') {
      capsuleHost.setAttribute('data-dock', 'fixed');
    }
    if (shouldShow) {
      updateFixedPosition();
    }
    if (popoverOpen) positionPopover();
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  function positionPopover() {
    if (!popoverOpen || disposed) return;
    const bRect = capsuleBtn.getBoundingClientRect();
    if (bRect.width === 0 && bRect.height === 0) return;

    const vw = Number(window.innerWidth || 1280);
    const vh = Number(window.innerHeight || 800);
    let minLeft = 12;
    const navEl = document.querySelector('div[role="navigation"]');
    if (navEl) {
      const nr = navEl.getBoundingClientRect();
      if (nr.width > 0 && nr.left <= 8 && nr.right < vw - 280) {
        minLeft = Math.max(12, Math.ceil(nr.right + 12));
      }
    }

    const panelW = Math.min(390, Math.max(280, vw - minLeft - 12));
    popoverEl.style.width = `${panelW}px`;
    const top = Math.max(38, Math.round(bRect.bottom + 6));
    const maxH = Math.max(220, vh - top - 12);
    popoverEl.style.maxHeight = `${maxH}px`;

    let left = Math.round(bRect.right - panelW);
    left = Math.min(left, vw - panelW - 12);
    left = Math.max(minLeft, left);
    popoverEl.style.top = `${top}px`;
    popoverEl.style.left = `${left}px`;
  }

  function setPopoverOpen(next) {
    popoverOpen = Boolean(next);
    capsuleBtn.classList.toggle('is-open', popoverOpen);
    capsuleBtn.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
    popoverEl.hidden = !popoverOpen;
    if (popoverOpen) {
      if (lastTelemetry) renderTelemetry(lastTelemetry);
      positionPopover();
      requestAnimationFrame(() => positionPopover());
      if (!lastTelemetry) void refreshTelemetry(false);
    }
  }

  // --- 8. 状态渲染 ---
  function renderQuotaRow(labelText, winObj) {
    const pct = winObj?.remainingPct;
    const hasPct = typeof pct === 'number' && Number.isFinite(pct);
    const toneClass = !hasPct ? '' : pct < 20 ? 'tone-danger' : pct < 50 ? 'tone-warn' : 'tone-ok';
    const fill = h('div', { className: `hud-progress-fill ${toneClass}` });
    fill.style.width = `${hasPct ? Math.max(0, Math.min(100, pct)) : 0}%`;

    return h('div', { className: 'hud-quota-row' }, [
      h('div', { className: 'hud-quota-row-head' }, [
        h('span', { className: 'hud-quota-win', text: labelText }),
        h('span', {
          className: 'hud-quota-meta',
          text: hasPct ? `${pct.toFixed(1)}% left · ${formatCountdown(winObj.resetTime)}` : 'Unavailable',
        }),
      ]),
      h('div', { className: 'hud-progress-track' }, [fill]),
    ]);
  }

  function renderTelemetry(data, errMsg = '') {
    if (data !== null) {
      lastTelemetry = data;
    }
    const d = data === null ? null : lastTelemetry;

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
        quotaListEl.replaceChildren(
          h('div', { className: 'hud-empty', text: errMsg ? `Disconnected: ${errMsg}` : 'Loading' })
        );
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

    const active = d.activeConversation;

    // 仅在浮层展开时更新内部重 DOM
    if (popoverOpen) {
      sshBadgeEl.hidden = !d.endpoint?.isRemote;
      sshBadgeEl.textContent = d.endpoint?.label || 'SSH';

      // 上下文窗口（简洁版：已用 / 总量 + 进度条）
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

      // 性能指标矩阵（平均值居主位，最新值居次位）
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

      // Token 消耗 3 列
      tokInputVal.textContent = formatTokens(tok.inputTokens || 0);
      tokCacheVal.textContent = formatTokens(tok.cacheReadTokens || 0);
      tokOutputVal.textContent = formatTokens(tok.outputTokens || 0);

      // 配额池（仅显示 Gemini 系列模型）
      const quotas = d.quotas || {};
      const rawPools = Array.isArray(quotas.pools) ? quotas.pools : [];
      const pools = rawPools.filter((p) => /gemini/i.test(String(p?.name || '')));
      if (pools.length === 0) {
        quotaListEl.replaceChildren(
          h('div', { className: 'hud-empty', text: 'Quota data unavailable' })
        );
      } else {
        quotaListEl.replaceChildren(
          ...pools.map((pool) => {
            const rows = [];
            if (pool.fiveHour) rows.push(renderQuotaRow('5-Hour Limit', pool.fiveHour));
            if (pool.weekly) rows.push(renderQuotaRow('Weekly Limit', pool.weekly));
            return h('div', { className: 'hud-quota-pool' }, [
              h('div', { className: 'hud-quota-pool-name', text: pool.name }),
              ...rows,
            ]);
          })
        );
      }

      const timeStr = new Date(d.timestampMs || Date.now()).toLocaleTimeString('en-US', { hour12: false });
      updatedTimeEl.textContent = timeStr;
    }
  }

  let pollTimer = null;
  let routeDebounceTimer = null;
  let activityCheckTimer = null;
  let lastFetchAtMs = 0;
  let routeGeneration = 0;
  let pendingRouteRefresh = false;

  function scheduleNextPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (disposed) return;
    const isRunning = Boolean(lastTelemetry?.activeConversation?.isRunning);
    const delay = isRunning ? RUNNING_POLL_MS : IDLE_POLL_MS;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (disposed) return;
      if (document.hidden || !getActiveConversationContext().inConversation) {
        scheduleNextPoll();
        return;
      }
      void refreshTelemetry(false);
    }, delay);
  }

  async function refreshTelemetry(force = false) {
    if (disposed) return;
    const ctx = getActiveConversationContext();
    if (!ctx.inConversation) {
      scheduleNextPoll();
      return;
    }
    if (refreshInFlight) {
      pendingRouteRefresh = true;
      return;
    }
    refreshInFlight = true;
    const reqGen = routeGeneration;
    const reqRouteId = ctx.cascadeId;
    if (reqRouteId) lastHostRouteId = reqRouteId;
    try {
      const data = await callBackend(force ? 'refresh' : 'telemetry', {
        force,
        hostRouteCascadeId: reqRouteId,
      });
      if (disposed) return;
      // 若请求期间已切换会话或离开对话页，直接丢弃过期结果，避免闪现上一个对话数据
      const currentCtx = getActiveConversationContext();
      if (reqGen !== routeGeneration || !currentCtx.inConversation) return;
      if (
        reqRouteId &&
        data?.activeConversation?.cascadeId &&
        data.activeConversation.cascadeId.toLowerCase() !== reqRouteId.toLowerCase()
      ) {
        return;
      }
      lastFetchAtMs = Date.now();
      renderTelemetry(data, '');
    } catch (err) {
      if (!disposed && reqGen === routeGeneration) {
        renderTelemetry(null, err?.message || 'Disconnected');
      }
    } finally {
      refreshInFlight = false;
      if (!disposed && pendingRouteRefresh) {
        pendingRouteRefresh = false;
        void refreshTelemetry(false);
      } else {
        scheduleNextPoll();
      }
    }
  }

  // --- 9. 全局监听、路由跟随与懒刷新调度 ---
  function isEventInside(e, el) {
    if (!el) return false;
    if (typeof e.composedPath === 'function') {
      return e.composedPath().includes(el);
    }
    return el.contains(e.target);
  }

  function scheduleActivityProbe(delayMs = 1500) {
    if (disposed || lastTelemetry?.activeConversation?.isRunning) return;
    if (activityCheckTimer) clearTimeout(activityCheckTimer);
    activityCheckTimer = setTimeout(() => {
      activityCheckTimer = null;
      if (!disposed && !document.hidden) {
        void refreshTelemetry(false);
      }
    }, delayMs);
  }

  const onDocMouseDown = (e) => {
    if (popoverOpen && !isEventInside(e, popoverEl) && !isEventInside(e, capsuleHost)) {
      setPopoverOpen(false);
    }
  };
  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && popoverOpen) {
      setPopoverOpen(false);
      return;
    }
    // 用户在输入框回车提交时，延迟探测一次以切入生成中 10s 轮询
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isEventInside(e, portalHost)) {
      scheduleActivityProbe(1500);
    }
  };
  const onDocSubmit = () => scheduleActivityProbe(1500);
  const onDocClick = (e) => {
    if (isEventInside(e, portalHost) || lastTelemetry?.activeConversation?.isRunning) return;
    const btn = e.target?.closest?.('button[type="submit"], button[aria-label*="Send" i], [data-testid*="send" i]');
    if (btn) scheduleActivityProbe(1500);
  };
  const onVisibilityChange = () => {
    if (disposed || document.hidden) return;
    const isRunning = Boolean(lastTelemetry?.activeConversation?.isRunning);
    const maxAge = isRunning ? RUNNING_POLL_MS : IDLE_POLL_MS;
    if (Date.now() - lastFetchAtMs >= maxAge) {
      void refreshTelemetry(false);
    }
  };
  const onWindowResize = () => {
    updateFixedPosition();
    if (popoverOpen) positionPopover();
  };
  const onRouteCheck = () => {
    const ctx = getActiveConversationContext();
    const shouldShow = ctx.inConversation;
    if (capsuleHost.hidden !== !shouldShow) {
      capsuleHost.hidden = !shouldShow;
    }
    if (!shouldShow && popoverOpen) {
      setPopoverOpen(false);
    }

    const nextRoute = ctx.cascadeId;
    if (nextRoute !== lastHostRouteId) {
      lastHostRouteId = nextRoute;
      routeGeneration += 1;
      // 立即清空上一个对话的缓存与展示，防止切换 ID 后残留旧数据
      lastTelemetry = null;
      lastFetchAtMs = 0;
      if (activityCheckTimer) {
        clearTimeout(activityCheckTimer);
        activityCheckTimer = null;
      }
      if (routeDebounceTimer) {
        clearTimeout(routeDebounceTimer);
        routeDebounceTimer = null;
      }
      renderTelemetry(null);

      if (shouldShow && nextRoute) {
        routeDebounceTimer = setTimeout(() => {
          routeDebounceTimer = null;
          if (!disposed) void refreshTelemetry(false);
        }, 60);
      }
    }
  };

  let origPushState = null;
  let origReplaceState = null;
  try {
    origPushState = history.pushState;
    origReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args);
      queueMicrotask(onRouteCheck);
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args);
      queueMicrotask(onRouteCheck);
      return ret;
    };
  } catch {}

  let themeObserver = null;
  let domObserver = null;
  let resizeObserver = null;
  let dockRaf = 0;

  function scheduleDockSync() {
    if (disposed || dockRaf) return;
    dockRaf = requestAnimationFrame(() => {
      dockRaf = 0;
      if (!disposed) {
        onRouteCheck();
        ensureDocked();
      }
    });
  }

  try {
    themeObserver = new MutationObserver(() => syncThemeScheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    if (document.body) {
      domObserver = new MutationObserver(() => scheduleDockSync());
      domObserver.observe(document.body, { childList: true, subtree: true });
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => scheduleDockSync());
        resizeObserver.observe(document.body);
      }
    }
  } catch {}

  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onDocKeyDown);
  document.addEventListener('submit', onDocSubmit, true);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('popstate', onRouteCheck);

  ensureDocked();
  if (lastTelemetry) renderTelemetry(lastTelemetry);
  if (carryOpen) setPopoverOpen(true);
  void refreshTelemetry(false);

  // 暴露生命周期句柄供 daemon 心跳检查与热卸载
  window.__agCtxHudOverlay = {
    bundleVersion,
    ensureAlive: () => ensureDocked(),
    isOpen: () => popoverOpen,
    getTelemetry: () => lastTelemetry,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (routeDebounceTimer) clearTimeout(routeDebounceTimer);
      if (activityCheckTimer) clearTimeout(activityCheckTimer);
      for (const p of pendingRpcs.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Overlay disposed'));
      }
      pendingRpcs.clear();
      if (dockRaf) cancelAnimationFrame(dockRaf);
      themeObserver?.disconnect();
      domObserver?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown);
      document.removeEventListener('submit', onDocSubmit, true);
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('popstate', onRouteCheck);
      try {
        if (origPushState) history.pushState = origPushState;
        if (origReplaceState) history.replaceState = origReplaceState;
      } catch {}
      capsuleHost.remove();
      portalHost.remove();
    },
  };
})();
