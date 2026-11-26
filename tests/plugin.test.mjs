/**
 * Context HUD 核心模块单元测试（使用 Node 内置 node:test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { handleMcpMessage } from '../src/server/mcp-entry.mjs';
import { isAntigravityAppTarget, parseDevToolsPort } from '../src/server/cdp-targets.mjs';
import { createLsClient } from '../src/server/ls-client.mjs';
import { assembleUiBundle } from '../src/server/ui-loader.mjs';
import { formatDuration, formatTokens } from '../src/ui/formatters.js';
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

test('UI module bundle assembles cleanly and formatter helpers work accurately', async () => {
  const bundle = await assembleUiBundle(join(ROOT_DIR, 'src/ui'));
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'overlay-bundle.js' }));
  assert.equal(formatTokens(15320), '15.3K');
  assert.equal(formatTokens(2_450_000), '2.45M');
  assert.equal(formatDuration(4.567), '4.57s');
  assert.equal(formatDuration(75), '1m 15s');
});

test('LS client enforces 10-minute fixed quota cadence and preserves last valid quota on errors', async () => {
  let callNum = 0;
  let nowMs = 1_000_000;
  const ls = createLsClient({
    nowFn: () => nowMs,
    remoteWindowRpc: async () => {
      callNum += 1;
      if (callNum === 1) {
        return {
          response: {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85 }],
              },
            ],
          },
        };
      }
      if (callNum === 2) {
        throw new Error('Quota service temporary timeout');
      }
      return { response: { groups: [] } };
    },
  });
  const target = { isRemote: true, wsUrl: 'ws://127.0.0.1:9999/devtools/page/1' };

  const first = await ls.getQuotaSummary({ remoteTarget: target });
  assert.equal(first.response.groups.length, 1);
  assert.equal(callNum, 1);

  // 10 分钟窗口内即使传入外部条件（如 force: true）也绝不重复查询配额
  nowMs += 9 * 60 * 1000;
  const cachedWithin10m = await ls.getQuotaSummary({ force: true, remoteTarget: target });
  assert.equal(cachedWithin10m.response.groups[0].buckets[0].remainingFraction, 0.85);
  assert.equal(callNum, 1);

  // 满 10 分钟触发第 2 次查询，遇到异常时仍保留上一次有效配额
  nowMs += 60 * 1000;
  const afterErr = await ls.getQuotaSummary({ remoteTarget: target });
  assert.equal(afterErr.response.groups[0].buckets[0].remainingFraction, 0.85);
  assert.equal(callNum, 2);

  // 再次满 10 分钟触发第 3 次查询，返回空组时同样保留上一次有效配额
  nowMs += 10 * 60 * 1000;
  const afterEmpty = await ls.getQuotaSummary({ remoteTarget: target });
  assert.equal(afterEmpty.response.groups[0].buckets[0].remainingFraction, 0.85);
  assert.equal(callNum, 3);
});
