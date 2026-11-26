/**
 * 自适应懒刷新与会话路由隔离调度器（空闲 10 分钟 / 生成中 10 秒 / 切换 ID 立即清空并拉取）。
 */

import { getActiveConversationContext } from './formatters.js';

export const IDLE_POLL_MS = 10 * 60 * 1000; // 空闲状态每 10 分钟拉取一次
export const RUNNING_POLL_MS = 10 * 1000;   // 生成中每 10 秒拉取一次

/** 创建覆盖路由监听、生成探测与懒刷新定时的调度控制器 */
export function createRefreshScheduler({
  callBackend,
  views,
  dock,
  capsuleHost,
  portalHost,
}) {
  let disposed = false;
  let refreshInFlight = false;
  let pendingRouteRefresh = false;
  let pollTimer = null;
  let routeDebounceTimer = null;
  let activityCheckTimer = null;
  let lastFetchAtMs = 0;
  let routeGeneration = 0;
  let lastHostRouteId = getActiveConversationContext().cascadeId;

  function scheduleNextPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (disposed) return;
    const isRunning = Boolean(views.getLastTelemetry()?.activeConversation?.isRunning);
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
      // 丢弃切换会话或离开对话页后的过期响应，杜绝旧会话数据回写闪现
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
      views.renderTelemetry(data, '');
    } catch (err) {
      if (!disposed && reqGen === routeGeneration && !views.getLastTelemetry()) {
        views.renderTelemetry(null, err?.message || 'Disconnected');
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

  function scheduleActivityProbe(delayMs = 1500) {
    if (disposed || views.getLastTelemetry()?.activeConversation?.isRunning) return;
    if (activityCheckTimer) clearTimeout(activityCheckTimer);
    activityCheckTimer = setTimeout(() => {
      activityCheckTimer = null;
      if (!disposed && !document.hidden) {
        void refreshTelemetry(false);
      }
    }, delayMs);
  }

  function onRouteCheck() {
    const ctx = getActiveConversationContext();
    const shouldShow = ctx.inConversation;
    if (capsuleHost.hidden !== !shouldShow) {
      capsuleHost.hidden = !shouldShow;
    }
    if (!shouldShow && views.isOpen()) {
      views.setPopoverOpen(false);
    }

    const nextRoute = ctx.cascadeId;
    if (nextRoute === lastHostRouteId) return;

    lastHostRouteId = nextRoute;
    routeGeneration += 1;
    lastFetchAtMs = 0;
    if (activityCheckTimer) {
      clearTimeout(activityCheckTimer);
      activityCheckTimer = null;
    }
    if (routeDebounceTimer) {
      clearTimeout(routeDebounceTimer);
      routeDebounceTimer = null;
    }
    views.renderTelemetry(null);

    if (shouldShow && nextRoute) {
      routeDebounceTimer = setTimeout(() => {
        routeDebounceTimer = null;
        if (!disposed) void refreshTelemetry(false);
      }, 60);
    }
  }

  function isEventInside(e, el) {
    if (!el) return false;
    if (typeof e.composedPath === 'function') {
      return e.composedPath().includes(el);
    }
    return el.contains(e.target);
  }

  const onDocMouseDown = (e) => {
    if (views.isOpen() && !isEventInside(e, views.popoverEl) && !isEventInside(e, capsuleHost)) {
      views.setPopoverOpen(false);
    }
  };
  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && views.isOpen()) {
      views.setPopoverOpen(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isEventInside(e, portalHost)) {
      scheduleActivityProbe(1500);
    }
  };
  const onDocSubmit = () => scheduleActivityProbe(1500);
  const onDocClick = (e) => {
    if (isEventInside(e, portalHost) || views.getLastTelemetry()?.activeConversation?.isRunning) return;
    const btn = e.target?.closest?.('button[type="submit"], button[aria-label*="Send" i], [data-testid*="send" i]');
    if (btn) scheduleActivityProbe(1500);
  };
  const onVisibilityChange = () => {
    if (disposed || document.hidden) return;
    const isRunning = Boolean(views.getLastTelemetry()?.activeConversation?.isRunning);
    const maxAge = isRunning ? RUNNING_POLL_MS : IDLE_POLL_MS;
    if (Date.now() - lastFetchAtMs >= maxAge) {
      void refreshTelemetry(false);
    }
  };
  const onWindowResize = () => {
    dock.updateFixedPosition();
    if (views.isOpen()) dock.positionPopover();
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

  let domObserver = null;
  let resizeObserver = null;
  let dockRaf = 0;
  function scheduleDockSync() {
    if (disposed || dockRaf) return;
    dockRaf = requestAnimationFrame(() => {
      dockRaf = 0;
      if (!disposed) {
        onRouteCheck();
        dock.ensureDocked();
      }
    });
  }

  try {
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

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (routeDebounceTimer) clearTimeout(routeDebounceTimer);
    if (activityCheckTimer) clearTimeout(activityCheckTimer);
    if (dockRaf) cancelAnimationFrame(dockRaf);
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
  }

  return { refreshTelemetry, onRouteCheck, dispose };
}
