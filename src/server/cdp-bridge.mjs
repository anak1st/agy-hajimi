/**
 * Antigravity App CDP 桥接与实时 DOM 热注入调度器。
 *
 * 负责维护活跃窗口 CDP 会话、热更新注入前端 UI、通过 `Runtime.addBinding` 接收双向 RPC 请求，
 * 以及将 SSH 远端窗口请求转发回页面内同源 Fetch 执行。
 */

import { homedir } from 'node:os';
import { CdpSession } from './cdp-session.mjs';
import {
  classifySessionEndpoint,
  discoverAppTargets,
  isAntigravityAppTarget,
  parseDevToolsPort,
} from './cdp-targets.mjs';

export { isAntigravityAppTarget, parseDevToolsPort };

export const BINDING_NAME = '__agCtxHudCallV1';

function buildInjectionSource({ css, js, bundleVersion, isRemote, endpointLabel }) {
  const configJson = JSON.stringify({
    binding: BINDING_NAME,
    bundleVersion: String(bundleVersion || '1.0.0'),
    stylesCss: css,
    isRemote: Boolean(isRemote),
    endpointLabel: String(endpointLabel || 'Local'),
  });
  return `(() => {
    window.__agCtxHudConfig = ${configJson};
  })();
  ${js}`;
}

function wrapOriginGuard(origin, rawSource) {
  return `if (window.location && window.location.origin === ${JSON.stringify(origin)}) {\n${rawSource}\n}`;
}

export function createCdpBridge({
  loadAssets,
  getBundleVersion,
  onRequest,
  getLocalHubInfo,
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  pollIntervalMs = 2500,
} = {}) {
  const sessions = new Map();
  let stopped = false;
  let syncTimer = null;
  let syncInFlight = null;

  async function replyToBinding(session, reqId, payload, executionContextId) {
    if (stopped || session.closed) return;
    const expr = `window.__agCtxHudResolve?.(${reqId}, ${JSON.stringify(payload)});`;
    await session
      .command(
        'Runtime.evaluate',
        {
          expression: expr,
          ...(executionContextId ? { contextId: executionContextId } : {}),
        },
        4000
      )
      .catch(() => {});
  }

  async function handleSessionEvent(session, msg) {
    if (stopped || session.closed) return;
    if (msg.method === 'Runtime.bindingCalled') {
      const p = msg.params || {};
      if (p.name !== BINDING_NAME) return;
      if (typeof p.payload !== 'string' || p.payload.length > 8192 || session.inflightCalls >= 8) return;

      let req;
      try {
        req = JSON.parse(p.payload);
      } catch {
        return;
      }
      if (!req || !Number.isSafeInteger(req.id)) return;

      session.inflightCalls += 1;
      try {
        const data = await onRequest(session, String(req.action || ''), req.params || {});
        await replyToBinding(session, req.id, { ok: true, data }, p.executionContextId);
      } catch (err) {
        await replyToBinding(
          session,
          req.id,
          { ok: false, error: err?.message || 'Bridge request failed' },
          p.executionContextId
        );
      } finally {
        session.inflightCalls = Math.max(0, session.inflightCalls - 1);
      }
      return;
    }

    if (msg.method === 'Runtime.executionContextsCleared') {
      // 页面重载或导航后重新注册 CDP Binding，确保前端通信不中断
      void session.command('Runtime.addBinding', { name: BINDING_NAME }).catch(() => {});
    }
  }

  async function injectIntoSession(session, bundleVersion) {
    const { css, js } = await loadAssets();
    const source = wrapOriginGuard(
      session.origin,
      buildInjectionSource({
        css,
        js,
        bundleVersion,
        isRemote: session.isRemote,
        endpointLabel: session.endpointLabel,
      })
    );
    if (session.preloadScriptId) {
      await session
        .command('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.preloadScriptId })
        .catch(() => {});
    }
    const added = await session.command('Page.addScriptToEvaluateOnNewDocument', { source });
    session.preloadScriptId = added?.identifier || null;
    await session.command('Runtime.evaluate', { expression: source });
  }

  async function attachTarget(target) {
    const session = new CdpSession(target, {
      onEvent: handleSessionEvent,
      onClose: (s) => {
        if (sessions.get(s.wsUrl) === s) sessions.delete(s.wsUrl);
      },
    });
    await session.open();
    if (stopped) {
      session.close();
      return null;
    }

    await session.command('Page.enable');
    await session.command('Runtime.enable');
    await session.command('Runtime.addBinding', { name: BINDING_NAME });
    await classifySessionEndpoint(session, getLocalHubInfo);
    await injectIntoSession(session, getBundleVersion());
    sessions.set(session.wsUrl, session);
    return session;
  }

  async function disposeSession(session) {
    if (!session) return;
    sessions.delete(session.wsUrl);
    if (session.closed) return;
    try {
      if (session.preloadScriptId) {
        await session
          .command('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.preloadScriptId })
          .catch(() => {});
      }
      await session.command('Runtime.removeBinding', { name: BINDING_NAME }).catch(() => {});
      await session
        .command('Runtime.evaluate', {
          expression: 'window.__agCtxHudOverlay?.dispose?.(); delete window.__agCtxHudOverlay; delete window.__agCtxHudResolve;',
        })
        .catch(() => {});
    } finally {
      session.close();
    }
  }

  async function syncOnce() {
    if (stopped) return;
    const targets = await discoverAppTargets(env, platform, homeDir).catch(() => []);
    const activeUrls = new Set(targets.map((t) => t.webSocketDebuggerUrl));

    for (const [wsUrl, session] of sessions.entries()) {
      if (!activeUrls.has(wsUrl) || session.closed) {
        await disposeSession(session);
      }
    }

    const bundleVersion = getBundleVersion();
    for (const target of targets) {
      if (stopped) break;
      const existing = sessions.get(target.webSocketDebuggerUrl);
      if (!existing) {
        await attachTarget(target).catch(() => {});
        continue;
      }

      try {
        const check = await existing.command(
          'Runtime.evaluate',
          {
            returnByValue: true,
            expression: `(() => {
              const ov = window.__agCtxHudOverlay;
              if (!ov || typeof ov.ensureAlive !== 'function') return { alive: false };
              return { alive: Boolean(ov.ensureAlive()), version: String(ov.bundleVersion || '') };
            })()`,
          },
          2000
        );
        const val = check?.result?.value;
        if (!val?.alive || val.version !== bundleVersion) {
          await injectIntoSession(existing, bundleVersion);
        }
      } catch {
        await disposeSession(existing);
      }
    }
  }

  function sync() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = syncOnce()
      .catch(() => {})
      .finally(() => {
        syncInFlight = null;
      });
    return syncInFlight;
  }

  function scheduleNext() {
    if (stopped) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void sync().finally(() => scheduleNext());
    }, pollIntervalMs);
    syncTimer.unref?.();
  }

  async function remoteWindowRpc(session, method, body = {}, timeoutMs = 5000) {
    if (!session || session.closed) {
      throw new Error('Remote window CDP session unavailable');
    }
    const expr = `(async () => {
      const origin = String(window.location?.origin || '').replace(/\\/+$/, '');
      const procedure = '/exa.language_server_pb.LanguageServerService/' + ${JSON.stringify(method)};
      const csrf = String(window.__APP_CONFIG__?.csrfToken || '').trim();
      const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
      if (csrf) headers['x-codeium-csrf-token'] = csrf;
      const res = await window.fetch(origin + procedure, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify(${JSON.stringify(body ?? {})}),
        signal: AbortSignal.timeout(${Math.max(1000, timeoutMs)}),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    })()`;
    const res = await session.command(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true },
      Math.max(2000, timeoutMs + 1000)
    );
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'Remote window RPC exception');
    }
    return res?.result?.value ?? {};
  }

  function start() {
    stopped = false;
    void sync().finally(() => scheduleNext());
  }

  async function stop({ disposeWindows = true } = {}) {
    stopped = true;
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (disposeWindows) {
      await Promise.allSettled(Array.from(sessions.values()).map((s) => disposeSession(s)));
    } else {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    }
  }

  return {
    start,
    stop,
    sync,
    remoteWindowRpc,
  };
}
