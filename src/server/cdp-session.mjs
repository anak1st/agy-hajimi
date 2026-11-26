/**
 * 单窗口 Chrome DevTools Protocol (CDP) WebSocket 会话传输封装。
 */

export class CdpSession {
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

  /** 建立 WebSocket 连接并绑定消息分发循环 */
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

  /** 发送 CDP JSON-RPC 命令 */
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
