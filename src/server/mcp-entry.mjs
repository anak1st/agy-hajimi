/**
 * 零工具开销的 MCP Stdio 宿主保活入口。
 *
 * `tools/list` 固定返回空数组 `[]`（0 上下文 Token 消耗），仅借用插件的启停生命周期
 * 自动拉起与优雅退出后台 CDP 守护进程。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(dirname(SERVER_DIR));
const MANIFEST_PATH = join(PLUGIN_ROOT, 'plugin.json');
const DAEMON_PATH = join(SERVER_DIR, 'daemon.mjs');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

export function readPluginVersion() {
  try {
    if (existsSync(MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // 忽略插件清单解析异常，回退默认版本号
  }
  return '1.0.0';
}

export function handleMcpMessage(msg, version = '1.0.0') {
  if (!msg || typeof msg !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(msg, 'id') || msg.id === undefined) {
    return null;
  }

  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agy-hajimi', version },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [] } };
  }
  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }
  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }
  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function startSupervisor() {
  const version = readPluginVersion();
  let shuttingDown = false;
  let daemonChild = null;
  let respawnTimer = null;
  let rapidCrashCount = 0;
  let lastSpawnMs = 0;

  function spawnDaemon() {
    if (shuttingDown) return;
    lastSpawnMs = Date.now();
    const child = spawn(process.execPath, [DAEMON_PATH], {
      cwd: SERVER_DIR,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    daemonChild = child;

    child.stderr?.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        // 忽略标准错误转发异常
      }
    });

    child.on('exit', (code) => {
      if (daemonChild === child) daemonChild = null;
      if (shuttingDown) return;

      const elapsed = Date.now() - lastSpawnMs;
      let delayMs = code === 0 ? 150 : 400;
      if (code !== 0 && elapsed < 10_000) {
        rapidCrashCount += 1;
        delayMs = Math.min(30_000, 1000 * 2 ** Math.min(rapidCrashCount - 1, 5));
      } else {
        rapidCrashCount = 0;
      }

      if (respawnTimer) clearTimeout(respawnTimer);
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        spawnDaemon();
      }, delayMs);
    });

    child.on('error', () => {
      // 由 exit 事件及退避重启逻辑统一兜底处理
    });
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    const child = daemonChild;
    if (!child) {
      process.exit(0);
      return;
    }
    const forceTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      process.exit(0);
    }, 1800);
    forceTimer.unref?.();

    child.once('exit', () => {
      clearTimeout(forceTimer);
      process.exit(0);
    });

    try {
      child.stdin?.write('SHUTDOWN_DISPOSE\n');
      child.stdin?.end();
    } catch {
      try {
        child.kill();
      } catch {}
      process.exit(0);
    }
  }

  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);

  function writeJsonRpc(payload, mode) {
    const serialized = JSON.stringify(payload);
    if (mode === 'lsp') {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  function dispatch(parsed, mode) {
    if (Array.isArray(parsed)) {
      const out = parsed.map((item) => handleMcpMessage(item, version)).filter(Boolean);
      if (out.length > 0) writeJsonRpc(out, mode);
      return;
    }
    const res = handleMcpMessage(parsed, version);
    if (res) writeJsonRpc(res, mode);
  }

  function drainBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfIdx = sepIdx < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx >= 0 ? sepIdx : lfIdx;
        const sepLen = sepIdx >= 0 ? 4 : 2;
        if (headerEnd < 0) return;

        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalLen) return;

        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalLen);
        try {
          dispatch(JSON.parse(bodyStr), 'lsp');
        } catch {}
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        dispatch(JSON.parse(lineStr), framingMode);
      } catch {}
    }
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainBuffer();
  });

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.resume();

  spawnDaemon();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startSupervisor();
}
