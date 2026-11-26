/**
 * Antigravity App Context HUD 注入入口：组装双 Shadow Host 与各 UI 控制模块。
 */

import { createHudViews } from './components.js';
import { createDockController } from './dock.js';
import { getActiveConversationContext } from './formatters.js';
import { createRpcClient } from './rpc-client.js';
import { createRefreshScheduler } from './scheduler.js';
import { attachStyles, observeThemeScheme } from './theme.js';

const CAPSULE_ID = 'ag-ctx-hud-capsule';
const PORTAL_ID = 'ag-ctx-hud-portal';

function bootstrapOverlay() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // 若已有旧实例，继承状态后安全卸载（支持前端模块热更新）
  let carryOpen = false;
  let carryTelemetry = null;
  let carryQuotaPools = [];
  try {
    const prev = window.__agCtxHudOverlay;
    if (prev) {
      carryOpen = Boolean(prev.isOpen?.());
      carryTelemetry = prev.getTelemetry?.() || null;
      carryQuotaPools = prev.getQuotaPools?.() || [];
      prev.dispose?.();
    }
  } catch {}
  document.getElementById(CAPSULE_ID)?.remove();
  document.getElementById(PORTAL_ID)?.remove();

  const cfg = window.__agCtxHudConfig || {};
  const bindingName = String(cfg.binding || '__agCtxHudCallV1');
  const bundleVersion = String(cfg.bundleVersion || '1.0.0');
  const stylesCss = String(cfg.stylesCss || '');

  const rpc = createRpcClient(bindingName);

  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_ID;
  capsuleHost.className = 'hud-capsule-host';
  capsuleHost.setAttribute('data-dock', 'flow');
  capsuleHost.addEventListener('mousedown', (e) => e.stopPropagation());
  capsuleHost.addEventListener('click', (e) => e.stopPropagation());
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });
  attachStyles(capsuleShadow, stylesCss);

  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_ID;
  portalHost.className = 'hud-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });
  attachStyles(portalShadow, stylesCss);

  const stopThemeObserver = observeThemeScheme([capsuleHost, portalHost]);

  let dock = null;
  let scheduler = null;

  const views = createHudViews({
    initialTelemetry: carryTelemetry,
    initialQuotaPools: carryQuotaPools,
    onTogglePopover: (next) => {
      views.setPopoverOpen(next);
      if (next && !views.getLastTelemetry()) {
        void scheduler?.refreshTelemetry(false);
      }
    },
    onForceRefresh: () => void scheduler?.refreshTelemetry(true),
    onPositionPopover: () => dock?.positionPopover(),
  });

  capsuleShadow.appendChild(views.capsuleBtn);
  portalShadow.appendChild(views.popoverEl);

  dock = createDockController({
    capsuleHost,
    capsuleBtn: views.capsuleBtn,
    portalHost,
    popoverEl: views.popoverEl,
    getContext: getActiveConversationContext,
    isPopoverOpen: views.isOpen,
    onClosePopover: () => views.setPopoverOpen(false),
  });

  scheduler = createRefreshScheduler({
    callBackend: rpc.callBackend,
    views,
    dock,
    capsuleHost,
    portalHost,
  });

  dock.ensureDocked();
  if (carryTelemetry) views.renderTelemetry(carryTelemetry);
  if (carryOpen) views.setPopoverOpen(true);
  void scheduler.refreshTelemetry(false);

  // 暴露生命周期句柄供 daemon 心跳检查与热卸载
  window.__agCtxHudOverlay = {
    bundleVersion,
    ensureAlive: () => dock.ensureDocked(),
    isOpen: views.isOpen,
    getTelemetry: views.getLastTelemetry,
    getQuotaPools: views.getLastQuotaPools,
    dispose: () => {
      scheduler.dispose();
      rpc.dispose();
      stopThemeObserver();
      capsuleHost.remove();
      portalHost.remove();
    },
  };
}

bootstrapOverlay();
