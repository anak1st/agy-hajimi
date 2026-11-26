/**
 * 前端分模块 ES 脚本零依赖组装加载器。
 *
 * 读取 `src/ui/` 下各独立 ES 模块与样式文件，剥离模块导入/导出语法并包裹进单个 IIFE，
 * 以供 CDP `Runtime.evaluate` 与 `Page.addScriptToEvaluateOnNewDocument` 原生注入。
 */

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UI_MODULE_FILES = [
  'rpc-client.js',
  'formatters.js',
  'theme.js',
  'dock.js',
  'components.js',
  'scheduler.js',
  'overlay.js',
];

/** 剥离单个 ESM 文件顶层 `import ... from './...'` 与 `export` 前缀以拼装浏览器 IIFE */
export function stripModuleSyntax(source) {
  return String(source || '')
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '')
    .trim();
}

/** 按拓扑顺序组装前端 JS 注入包 */
export async function assembleUiBundle(uiDir) {
  const parts = await Promise.all(
    UI_MODULE_FILES.map(async (file) => {
      const raw = await readFile(join(uiDir, file), 'utf8');
      return `// === ${file} ===\n${stripModuleSyntax(raw)}`;
    })
  );
  return `(() => {\n'use strict';\n${parts.join('\n\n')}\n})();`;
}

/** 计算 UI CSS 与全部分模块 JS 的版本指纹（任一文件更新即触发热更新） */
export function getUiBundleVersion(uiDir) {
  try {
    const files = ['overlay.css', ...UI_MODULE_FILES];
    const mtimes = files.map((file) => {
      try {
        return Math.trunc(statSync(join(uiDir, file)).mtimeMs);
      } catch {
        return 0;
      }
    });
    return mtimes.join('-');
  } catch {
    return '1';
  }
}

/** 加载 CSS 与组装后的前端脚本 */
export async function loadUiAssets(uiDir) {
  const [css, js] = await Promise.all([
    readFile(join(uiDir, 'overlay.css'), 'utf8'),
    assembleUiBundle(uiDir),
  ]);
  return { css, js };
}
