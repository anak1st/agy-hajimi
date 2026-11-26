/**
 * Shadow DOM 样式注入与宿主亮/暗极性自动同步。
 */

function parseColorLuminance(cssColor) {
  const str = String(cssColor || '').trim();
  if (!str) return null;
  const probe = document.createElement('span');
  probe.style.color = str;
  probe.style.display = 'none';
  document.body?.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const m = computed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 检测宿主当前是深色还是浅色主题 */
export function detectDarkScheme() {
  const html = document.documentElement;
  const cls = `${html?.className || ''} ${document.body?.className || ''}`.toLowerCase();
  const dataTheme = String(html?.getAttribute('data-theme') || '').toLowerCase();
  if (dataTheme.includes('dark') || /\bdark\b/.test(cls)) return true;
  if (dataTheme.includes('light') || /\blight\b/.test(cls)) return false;
  const bg = getComputedStyle(html).getPropertyValue('--background') || getComputedStyle(document.body).backgroundColor;
  const lum = parseColorLuminance(bg);
  return lum !== null ? lum < 0.5 : false;
}

/** 向 ShadowRoot 挂载样式（优先使用 adoptedStyleSheets） */
export function attachStyles(shadowRoot, stylesCss) {
  if (!stylesCss) return;
  if (typeof CSSStyleSheet === 'function' && Array.isArray(shadowRoot.adoptedStyleSheets)) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(stylesCss);
      shadowRoot.adoptedStyleSheets = [sheet];
      return;
    } catch {}
  }
  const styleEl = document.createElement('style');
  styleEl.textContent = stylesCss;
  shadowRoot.appendChild(styleEl);
}

/** 同步胶囊宿主与浮层宿主的明暗主题属性，并监听宿主根节点切换 */
export function observeThemeScheme(hosts) {
  const sync = () => {
    const scheme = detectDarkScheme() ? 'dark' : 'light';
    for (const host of hosts) {
      host.setAttribute('data-color-scheme', scheme);
    }
  };
  sync();

  let observer = null;
  try {
    observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
  } catch {}

  return () => observer?.disconnect();
}
