/**
 * Context HUD 核心模块单元测试（使用 Node 内置 node:test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { handleMcpMessage } from '../src/server/mcp-entry.mjs';
import { isAntigravityAppTarget, parseDevToolsPort } from '../src/server/cdp-bridge.mjs';
import {
  buildTelemetrySnapshot,
  computeDurationSec,
  parseDurationSec,
} from '../src/server/metrics.mjs';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

test('MCP 0-tool entry handles initialize, ping, and empty tools/list', () => {
  const initRes = handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  }, '1.0.0');
  assert.equal(initRes.result.protocolVersion, '2025-11-25');
  assert.equal(initRes.result.serverInfo.name, 'agy-hajimi');

  const toolsRes = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(toolsRes.result.tools, []);

  const pingRes = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(pingRes.result, {});
});

test('CDP target filter accepts only Antigravity App loopback pages', () => {
  assert.equal(parseDevToolsPort('59123\n/devtools/browser/abc\n'), 59123);
  assert.equal(parseDevToolsPort('invalid'), null);

  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'https://127.0.0.1:62985/c/a41330b8-223e-4c52-9141-8c42f76ceb9c',
      webSocketDebuggerUrl: 'ws://127.0.0.1:59123/devtools/page/1',
    }, 59123),
    true
  );

  // 排除 IDE workbench、webview 与外部页面
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'vscode-file://vscode-app/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:59123/devtools/page/2',
    }, 59123),
    false
  );
  assert.equal(
    isAntigravityAppTarget({
      type: 'iframe',
      url: 'https://127.0.0.1:62985/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:59123/devtools/page/3',
    }, 59123),
    false
  );
});

test('BigInt nanosecond duration and telemetry aggregation compute accurate TPS and context', () => {
  // 499.999999ms 必须保持严格小于 0.5s（避免 IEEE-754 浮点精度进位误差）
  const subHalfSec = computeDurationSec('2026-11-26T01:00:00.000000000Z', '2026-11-26T01:00:00.499999999Z');
  assert.ok(subHalfSec !== null && subHalfSec < 0.5);
  assert.equal(parseDurationSec('6.098205042s'), 6.098205042);

  const snap = buildTelemetrySnapshot({
    summariesRes: {
      trajectorySummaries: {
        'a41330b8-223e-4c52-9141-8c42f76ceb9c': {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          stepCount: 12,
          summary: 'Build Context HUD',
          lastModifiedTime: '2026-11-26T01:08:12Z',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///Users/demo/agy-hajimi' }],
        },
      },
    },
    userStatusRes: {
      userStatus: {
        userTier: { name: 'Google AI Pro' },
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 4 Hydrogen (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M525' },
            },
          ],
        },
      },
    },
    quotaRes: {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.92, resetTime: '2026-11-26T06:00:00Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.71, resetTime: '2026-12-01T00:00:00Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: 'claude-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-26T06:00:00Z' },
            ],
          },
        ],
      },
    },
    trajectoryRes: {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            metadata: {
              createdAt: '2026-11-26T01:08:10.000000Z',
              finishedGeneratingAt: '2026-11-26T01:08:15.000000Z',
              generatorModel: 'MODEL_PLACEHOLDER_M525',
              modelUsage: {
                model: 'MODEL_PLACEHOLDER_M525',
                inputTokens: '4000',
                cacheReadTokens: '36000',
                outputTokens: '500',
                thinkingOutputTokens: '200',
                responseOutputTokens: '300',
                responseId: 'resp-1',
              },
            },
          },
        ],
        generatorMetadata: [
          {
            stepIndices: [0],
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M525',
              timeToFirstToken: '1.25s',
              usage: { responseId: 'resp-1' },
              chatStartMetadata: {
                contextWindowMetadata: {
                  estimatedTokensUsed: 256000,
                  maxContextTokens: 512000,
                },
              },
            },
          },
        ],
      },
    },
  });

  assert.equal(snap.activeConversation.modelLabel, 'Gemini 4 Hydrogen (High)');
  assert.equal(snap.context.usedTokens, 256000);
  assert.equal(snap.context.maxTokens, 512000);
  assert.equal(snap.context.usedPct, 50);
  assert.equal(snap.context.remainingTokens, 256000);
  assert.equal(snap.performance.latestTps, 100);
  assert.equal(snap.performance.latestTtftSec, 1.25);
  assert.equal(snap.performance.latestCacheHitPct, 90);
  assert.equal(snap.quotas.tierName, 'Google AI Pro');
  assert.equal(snap.quotas.pools.length, 1);
  assert.equal(snap.quotas.pools[0].name, 'Gemini Models');
  assert.equal(snap.quotas.pools[0].fiveHour.remainingPct, 92);

  // 指定新会话 ID 时绝不能回退泄露其他会话的数据
  const newChatSnap = buildTelemetrySnapshot({
    summariesRes: {
      trajectorySummaries: {
        'a41330b8-223e-4c52-9141-8c42f76ceb9c': {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          stepCount: 12,
          summary: 'Old Session',
          lastModifiedTime: '2026-11-26T01:08:12Z',
        },
      },
    },
    hostRouteCascadeId: '99999999-9999-9999-9999-999999999999',
  });
  assert.equal(newChatSnap.activeConversation.cascadeId, '99999999-9999-9999-9999-999999999999');
  assert.equal(newChatSnap.activeConversation.stepCount, 0);
  assert.equal(newChatSnap.context.usedPct, null);
  assert.equal(newChatSnap.tokens.totalTokens, 0);
});

test('UI overlay script parses as valid JavaScript', () => {
  const jsSource = readFileSync(join(ROOT_DIR, 'src/ui/overlay.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(jsSource, { filename: 'overlay.js' }));
});
