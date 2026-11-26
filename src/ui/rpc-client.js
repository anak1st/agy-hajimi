/**
 * CDP `Runtime.addBinding` 双向通信客户端封装。
 */

/** 创建绑定到宿主页面全局函数名的异步 RPC 客户端 */
export function createRpcClient(bindingName) {
  let reqSeq = 0;
  const pendingRpcs = new Map();

  window.__agCtxHudResolve = (id, payload) => {
    const entry = pendingRpcs.get(id);
    if (!entry) return;
    pendingRpcs.delete(id);
    clearTimeout(entry.timer);
    if (payload && payload.ok) {
      entry.resolve(payload.data);
    } else {
      entry.reject(new Error(payload?.error || 'Request failed'));
    }
  };

  function callBackend(action, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const fn = window[bindingName];
      if (typeof fn !== 'function') {
        reject(new Error('CDP bridge binding unavailable'));
        return;
      }
      const id = ++reqSeq;
      const timer = setTimeout(() => {
        pendingRpcs.delete(id);
        reject(new Error('Bridge request timeout'));
      }, timeoutMs);
      pendingRpcs.set(id, { resolve, reject, timer });
      try {
        fn(JSON.stringify({ id, action, params }));
      } catch (err) {
        pendingRpcs.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function dispose() {
    for (const p of pendingRpcs.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Overlay disposed'));
    }
    pendingRpcs.clear();
  }

  return { callBackend, dispose };
}
