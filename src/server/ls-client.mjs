/**
 * Antigravity App Language Server 自动发现与 Connect-RPC 客户端。
 *
 * 通过 `~/.gemini/antigravity/daemon/hub_*.json`（或环境变量 `ANTIGRAVITY_LS_ADDRESS` /
 * `ANTIGRAVITY_CSRF_TOKEN`）定位本地桌面端语言服务，并支持通过 CDP 窗口内转发调通 SSH 远端会话。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const QUOTA_CACHE_TTL_MS = 10 * 60 * 1000; // 配额固定每 10 分钟查询一次，不受外部条件影响

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function getDaemonDir(homeDir = homedir()) {
  const geminiBase = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  return join(geminiBase, 'antigravity', 'daemon');
}

export function discoverLocalHubEndpoints(homeDir = homedir()) {
  const daemonDir = getDaemonDir(homeDir);
  if (!existsSync(daemonDir)) return [];

  const found = [];
  let entries = [];
  try {
    entries = readdirSync(daemonDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of entries) {
    if (!ent.isFile() || !/^hub_.*\.json$/i.test(ent.name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(daemonDir, ent.name), 'utf8'));
      const pid = Number(raw?.pid || 0);
      if (pid > 0 && !isPidAlive(pid)) continue;
      const httpPort = Number(raw?.httpPort || 0);
      const httpsPort = Number(raw?.httpsPort || 0);
      const csrfToken = String(raw?.csrfToken || '').trim();
      if (!csrfToken) continue;
      if (httpPort > 0 || httpsPort > 0) {
        found.push({
          pid,
          httpPort,
          httpsPort,
          csrfToken,
          lsVersion: String(raw?.lsVersion || ''),
          file: ent.name,
        });
      }
    } catch {
      // 忽略损坏或写入中的瞬态 hub 描述文件
    }
  }
  return found;
}

function postLoopbackJson(urlStr, csrfToken, bodyObj, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj ?? {}), 'utf8');
    let settled = false;

    const req = transport.request(
      {
        hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: Number(parsed.port || (isHttps ? 443 : 80)),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        ...(isHttps ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Content-Length': payload.length,
          ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ ok: true, status: res.statusCode, data: text ? JSON.parse(text) : {} });
            } catch (err) {
              reject(new Error(`Invalid JSON from LS: ${err.message}`));
            }
          } else {
            resolve({ ok: false, status: res.statusCode || 500, errorText: text });
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      if (!settled) {
        settled = true;
        req.destroy(new Error(`LS RPC timeout after ${timeoutMs}ms`));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.write(payload);
    req.end();
  });
}

export function createLsClient({ homeDir = homedir(), remoteWindowRpc = null, nowFn = Date.now } = {}) {
  let cachedEndpoint = null;
  let userStatusCache = { ts: 0, data: null };
  const lastValidUserStatus = new Map();
  const quotaStateByScope = new Map();

  function getScopeKey(remoteTarget) {
    if (!remoteTarget?.isRemote) return 'local';
    return String(remoteTarget.wsUrl || remoteTarget.endpointLabel || 'remote');
  }

  function hasQuotaGroups(data) {
    const payload = data?.response !== undefined ? data.response : data;
    return Array.isArray(payload?.groups) && payload.groups.length > 0;
  }

  function resolveLocalEndpoint({ force = false } = {}) {
    if (!force && cachedEndpoint && (!cachedEndpoint.pid || isPidAlive(cachedEndpoint.pid))) {
      return cachedEndpoint;
    }

    const envAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
    const envCsrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
    if (envAddr && envCsrf) {
      const baseUrl = /^https?:\/\//i.test(envAddr) ? envAddr.replace(/\/+$/, '') : `http://${envAddr}`;
      cachedEndpoint = { baseUrl, csrfToken: envCsrf, pid: 0 };
      return cachedEndpoint;
    }

    const hubs = discoverLocalHubEndpoints(homeDir);
    if (hubs.length > 0) {
      const hub = hubs[0];
      const baseUrl = hub.httpPort > 0
        ? `http://127.0.0.1:${hub.httpPort}`
        : `https://127.0.0.1:${hub.httpsPort}`;
      cachedEndpoint = {
        baseUrl,
        csrfToken: hub.csrfToken,
        pid: hub.pid,
        httpPort: hub.httpPort,
        httpsPort: hub.httpsPort,
        lsVersion: hub.lsVersion,
      };
      return cachedEndpoint;
    }

    cachedEndpoint = null;
    return null;
  }

  async function callLocalRpc(method, body = {}, timeoutMs = 5000) {
    let ep = resolveLocalEndpoint({ force: false });
    if (!ep) ep = resolveLocalEndpoint({ force: true });
    if (!ep) {
      throw new Error('Antigravity Language Server not found (no active hub_*.json)');
    }

    let res;
    try {
      res = await postLoopbackJson(`${ep.baseUrl}${SERVICE_PREFIX}${method}`, ep.csrfToken, body, timeoutMs);
    } catch (err) {
      const refreshed = resolveLocalEndpoint({ force: true });
      if (refreshed && (refreshed.baseUrl !== ep.baseUrl || refreshed.csrfToken !== ep.csrfToken)) {
        res = await postLoopbackJson(`${refreshed.baseUrl}${SERVICE_PREFIX}${method}`, refreshed.csrfToken, body, timeoutMs);
      } else {
        throw err;
      }
    }

    if (!res.ok && (res.status === 401 || res.status === 403)) {
      const refreshed = resolveLocalEndpoint({ force: true });
      if (refreshed && (refreshed.baseUrl !== ep.baseUrl || refreshed.csrfToken !== ep.csrfToken)) {
        res = await postLoopbackJson(`${refreshed.baseUrl}${SERVICE_PREFIX}${method}`, refreshed.csrfToken, body, timeoutMs);
      }
    }

    if (!res.ok) {
      throw new Error(`LS RPC ${method} failed (${res.status}): ${res.errorText?.slice(0, 200) || ''}`);
    }
    return res.data;
  }

  async function callRpc(method, body = {}, { timeoutMs = 5000, remoteTarget = null } = {}) {
    if (remoteTarget?.isRemote && typeof remoteWindowRpc === 'function') {
      return remoteWindowRpc(remoteTarget, method, body, timeoutMs);
    }
    return callLocalRpc(method, body, timeoutMs);
  }

  async function getUserStatus({ force = false, remoteTarget = null } = {}) {
    const now = nowFn();
    const scopeKey = getScopeKey(remoteTarget);
    if (!remoteTarget?.isRemote && !force && userStatusCache.data && now - userStatusCache.ts < 30_000) {
      return userStatusCache.data;
    }
    try {
      const data = await callRpc('GetUserStatus', {}, { timeoutMs: 3000, remoteTarget });
      if (data && typeof data === 'object' && data.userStatus) {
        lastValidUserStatus.set(scopeKey, data);
        if (!remoteTarget?.isRemote) {
          userStatusCache = { ts: now, data };
        }
        return data;
      }
      return lastValidUserStatus.get(scopeKey) || data;
    } catch (err) {
      if (lastValidUserStatus.has(scopeKey)) {
        return lastValidUserStatus.get(scopeKey);
      }
      throw err;
    }
  }

  async function getQuotaSummary({ remoteTarget = null } = {}) {
    const now = nowFn();
    const scopeKey = getScopeKey(remoteTarget);
    const prev = quotaStateByScope.get(scopeKey) || { lastAttemptTs: 0, data: null };

    // 固定 10 分钟内直接返回已缓存的配额（不受切会话、生成中或手动强制刷新等外部条件影响）
    if (prev.lastAttemptTs > 0 && now - prev.lastAttemptTs < QUOTA_CACHE_TTL_MS && prev.data) {
      return prev.data;
    }

    try {
      const data = await callRpc('RetrieveUserQuotaSummary', { forceRefresh: false }, { timeoutMs: 5000, remoteTarget });
      if (hasQuotaGroups(data)) {
        quotaStateByScope.set(scopeKey, { lastAttemptTs: now, data });
        return data;
      }
      if (prev.data) {
        quotaStateByScope.set(scopeKey, { lastAttemptTs: now, data: prev.data });
        return prev.data;
      }
      quotaStateByScope.set(scopeKey, { lastAttemptTs: now, data: null });
      return data;
    } catch (err) {
      if (prev.data) {
        quotaStateByScope.set(scopeKey, { lastAttemptTs: now, data: prev.data });
        return prev.data;
      }
      throw err;
    }
  }

  function getLocalHubPorts() {
    const hubs = discoverLocalHubEndpoints(homeDir);
    const ports = new Set();
    const csrfTokens = new Set();
    for (const h of hubs) {
      if (h.httpPort > 0) ports.add(h.httpPort);
      if (h.httpsPort > 0) ports.add(h.httpsPort);
      if (h.csrfToken) csrfTokens.add(h.csrfToken);
    }
    return { ports, csrfTokens };
  }

  return {
    resolveLocalEndpoint,
    getLocalHubPorts,
    callRpc,
    getUserStatus,
    getQuotaSummary,
  };
}
