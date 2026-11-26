/**
 * Antigravity App CDP 调试端口发现、窗口白名单筛选与本地/SSH 远端识别模块。
 */

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 按平台解析 Antigravity 桌面端 DevToolsActivePort 文件候选路径 */
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

/** 提取 DevToolsActivePort 首行有效端口号 */
export function parseDevToolsPort(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const firstLine = rawText.split(/\r?\n/)[0]?.trim() || '';
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** 仅允许注入 Antigravity App 主窗口（过滤 VS Code / webview / 外部网页） */
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

/** 扫描当前活跃的本地 CDP 调试端口 */
export function findActiveCdpPorts(env = process.env, platform = process.platform, homeDir = homedir()) {
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

/** 发现所有可注入的 Antigravity App 主窗口目标 */
export async function discoverAppTargets(env = process.env, platform = process.platform, homeDir = homedir()) {
  const ports = findActiveCdpPorts(env, platform, homeDir);
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

/** 判断指定 CDP 窗口属于本地桌面端还是 Remote SSH 远端窗口 */
export async function classifySessionEndpoint(session, getLocalHubInfo) {
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
