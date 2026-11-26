/**
 * Antigravity App CDP 桥接与实时 DOM 热注入器。
 *
 * 通过 `DevToolsActivePort` 仅筛选 Antigravity App 主窗口（`https://127.0.0.1|localhost|[::1]:<port>`），
 * 并利用 CDP `Runtime.addBinding` 在注入的 Shadow DOM UI 与后台守护进程间建立零端口双向通信。
 */

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BINDING_NAME = '__agCtxHudCallV1';

export function resolveAppDevToolsPortFiles(env = process.env, platform = process.platform, homeDir = homedir()) {
  const explicit = String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim();
  if (explicit) return [explicit];

  if (platform === 'darwin') {
    return [
      join(homeDir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      join(homeDir, '.config', 'Antigravity', 'DevToolsActivePort'),
    ];
  }
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    return [
      join(appData, 'Antigravity', 'DevToolsActivePort'),
      join(localAppData, 'Antigravity', 'DevToolsActivePort'),
    ];
  }
  const configHome = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
  return [
    join(configHome, 'Antigravity', 'DevToolsActivePort'),
    join(configHome, 'antigravity', 'DevToolsActivePort'),
  ];
}

export function parseDevToolsPort(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const firstLine = rawText.split(/\r?\n/)[0]?.trim() || '';
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function isAntigravityAppTarget(target, expectedPort = 0) {
  if (!target || typeof target !== 'object') return false;
  if (target.type !== 'page') return false;
  const urlStr = String(target.url || '').trim();
  const wsStr = String(target.webSocketDebuggerUrl || '').trim();
  if (!/^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(urlStr)) {
    return false;
  }
  if (!/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(wsStr)) {
    return false;
  }
  if (expectedPort > 0) {
    try {
      const wsPort = Number(new URL(wsStr).port || 0);
      if (wsPort !== expectedPort) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function httpGetJson(port, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`CDP HTTP ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
        if (raw.length > 2 * 1024 * 1024) {
          req.destroy(new Error('CDP /json/list response too large'));
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP /json/list timeout')));
    req.on('error', reject);
  });
}

class CdpSession {
  constructor(target, { onEvent = null, onClose = null, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.target = target;
    this.wsUrl = String(target.webSocketDebuggerUrl);
    this.origin = new URL(target.url).origin;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.preloadScriptId = null;
    this.isRemote = false;
    this.endpointLabel = 'Local';
    this.inflightCalls = 0;
  }

  open(timeoutMs = 4000) {
    const WS = this.WebSocketImpl;
    if (typeof WS !== 'function') {
      return Promise.reject(new Error('WebSocket unavailable in this Node runtime'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WS(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.close();
          reject(new Error('CDP WebSocket open timeout'));
        }
      }, timeoutMs);

      ws.addEventListener('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      }, { once: true });

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.close();
          reject(new Error('CDP WebSocket open failed'));
        }
      }, { once: true });

      ws.addEventListener('message', (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : String(ev.data || '');
          const msg = JSON.parse(raw);
          if (msg.id) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) {
              p.reject(new Error(msg.error.message || `CDP error ${msg.error.code}`));
            } else {
              p.resolve(msg.result || {});
            }
          } else if (msg.method && typeof this.onEvent === 'function') {
            this.onEvent(this, msg);
          }
        } catch {
          // 忽略格式异常的 WebSocket 帧
        }
      });

      ws.addEventListener('close', () => this.handleDisconnect());
    });
  }

  command(method, params = {}, timeoutMs = 5000) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP session closed'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  handleDisconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP session disconnected'));
    }
    this.pending.clear();
    if (typeof this.onClose === 'function') {
      this.onClose(this);
    }
  }

  close() {
    this.handleDisconnect();
    try {
      this.ws?.close();
    } catch {}
  }
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

  function findActiveCdpPorts() {
    const files = resolveAppDevToolsPortFiles(env, platform, homeDir);
    const ports = [];
    const seen = new Set();
    for (const file of files) {
      try {
        if (!existsSync(file)) continue;
        const port = parseDevToolsPort(readFileSync(file, 'utf8'));
        if (port && !seen.has(port)) {
          seen.add(port);
          ports.push(port);
        }
      } catch {}
    }
    return ports;
  }

  async function discoverTargets() {
    const ports = findActiveCdpPorts();
    if (ports.length === 0) return [];
    const out = [];
    const seenWs = new Set();
    const settled = await Promise.allSettled(
      ports.map(async (port) => {
        const list = await httpGetJson(port, '/json/list');
        if (!Array.isArray(list)) return [];
        return list.filter((t) => isAntigravityAppTarget(t, port));
      })
    );
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue;
      for (const t of item.value) {
        if (!seenWs.has(t.webSocketDebuggerUrl)) {
          seenWs.add(t.webSocketDebuggerUrl);
          out.push(t);
        }
      }
    }
    return out;
  }

  function buildInjectionSource({ css, js, bundleVersion, isRemote, endpointLabel }) {
    const configJson = JSON.stringify({
      binding: BINDING_NAME,
      bundleVersion: String(bundleVersion || '1.0.0'),
      stylesCss: css,
      isRemote: Boolean(isRemote),
      endpointLabel: String(endpointLabel || 'Local'),
    });
    return `(() => {
      if (location.origin !== ${JSON.stringify('')}) { /* checked per origin below */ }
      window.__agCtxHudConfig = ${configJson};
    })();
    ${js}`;
  }

  function wrapOriginGuard(origin, rawSource) {
    return `if (window.location && window.location.origin === ${JSON.stringify(origin)}) {\n${rawSource}\n}`;
  }

  async function classifySessionEndpoint(session) {
    try {
      const probe = await session.command(
        'Runtime.evaluate',
        {
          returnByValue: true,
          expression: `(() => {
            try {
              const cfg = window.__APP_CONFIG__ && typeof window.__APP_CONFIG__ === 'object' ? window.__APP_CONFIG__ : null;
              return {
                origin: String(window.location?.origin || ''),
                title: String(document?.title || ''),
                csrfToken: String(cfg?.csrfToken || ''),
                isRemote: Boolean(cfg?.isRemote || cfg?.isRemoteControl || cfg?.isSsh || cfg?.sshHost || cfg?.remoteHost),
                sshHost: String(cfg?.sshHost || cfg?.sshHostName || cfg?.remoteHost || cfg?.remoteName || ''),
              };
            } catch {
              return null;
            }
          })()`,
        },
        2000
      );
      const info = probe?.result?.value;
      if (!info) return;
      const hubInfo = typeof getLocalHubInfo === 'function' ? getLocalHubInfo() : { ports: new Set(), csrfTokens: new Set() };
      let port = 0;
      try {
        port = Number(new URL(info.origin || session.origin).port || 0);
      } catch {}
      const matchesLocal =
        (port > 0 && hubInfo.ports.has(port)) ||
        (info.csrfToken && hubInfo.csrfTokens.has(info.csrfToken));
      const titleMatch = info.title.match(/\[SSH:\s*([^\]\r\n]+)\]/i);
      const sshHost = info.sshHost || (titleMatch ? titleMatch[1].trim() : '');

      if ((info.isRemote || sshHost || (!matchesLocal && hubInfo.ports.size > 0)) && !matchesLocal) {
        session.isRemote = true;
        session.endpointLabel = sshHost ? `SSH: ${sshHost}` : `SSH:${port || 'remote'}`;
      } else {
        session.isRemote = false;
        session.endpointLabel = 'Local';
      }
    } catch {
      // 探针瞬时失败时保持默认 Local 标记
    }
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
        if (stopped || session.closed) return;
        const replyExpr = `window.__agCtxHudResolve?.(${req.id}, ${JSON.stringify({ ok: true, data })});`;
        await session.command(
          'Runtime.evaluate',
          {
            expression: replyExpr,
            ...(p.executionContextId ? { contextId: p.executionContextId } : {}),
          },
          4000
        ).catch(() => {});
      } catch (err) {
        if (stopped || session.closed) return;
        const replyExpr = `window.__agCtxHudResolve?.(${req.id}, ${JSON.stringify({
          ok: false,
          error: err?.message || 'Bridge request failed',
        })});`;
        await session.command(
          'Runtime.evaluate',
          {
            expression: replyExpr,
            ...(p.executionContextId ? { contextId: p.executionContextId } : {}),
          },
          4000
        ).catch(() => {});
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

  async function attachTarget(target) {
    const session = new CdpSession(target, {
      onEvent: handleSessionEvent,
      onClose: (s) => {
        if (sessions.get(s.wsUrl) === s) {
          sessions.delete(s.wsUrl);
        }
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
    await classifySessionEndpoint(session);

    const { css, js } = await loadAssets();
    const bundleVersion = getBundleVersion();
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

    const added = await session.command('Page.addScriptToEvaluateOnNewDocument', { source });
    session.preloadScriptId = added?.identifier || null;
    await session.command('Runtime.evaluate', { expression: source });
    sessions.set(session.wsUrl, session);
    return session;
  }

  async function disposeSession(session) {
    if (!session) return;
    sessions.delete(session.wsUrl);
    if (!session.closed) {
      try {
        if (session.preloadScriptId) {
          await session.command('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: session.preloadScriptId,
          }).catch(() => {});
        }
        await session.command('Runtime.removeBinding', { name: BINDING_NAME }).catch(() => {});
        await session.command('Runtime.evaluate', {
          expression: 'window.__agCtxHudOverlay?.dispose?.(); delete window.__agCtxHudOverlay; delete window.__agCtxHudResolve;',
        }).catch(() => {});
      } finally {
        session.close();
      }
    }
  }

  async function syncOnce() {
    if (stopped) return;
    const targets = await discoverTargets().catch(() => []);
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
          const { css, js } = await loadAssets();
          const source = wrapOriginGuard(
            existing.origin,
            buildInjectionSource({
              css,
              js,
              bundleVersion,
              isRemote: existing.isRemote,
              endpointLabel: existing.endpointLabel,
            })
          );
          if (existing.preloadScriptId) {
            await existing.command('Page.removeScriptToEvaluateOnNewDocument', {
              identifier: existing.preloadScriptId,
            }).catch(() => {});
          }
          const added = await existing.command('Page.addScriptToEvaluateOnNewDocument', { source });
          existing.preloadScriptId = added?.identifier || null;
          await existing.command('Runtime.evaluate', { expression: source });
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
    findActiveCdpPorts,
    discoverTargets,
  };
}
