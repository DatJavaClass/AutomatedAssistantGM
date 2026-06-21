// WebSocket client with exponential-backoff reconnection. Backoff schedule:
// 1s, 2s, 4s, 8s, then capped at 30s indefinitely. Reconnect attempts continue
// until stop() is called explicitly (e.g. when the user disables the module).

const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000];
const BACKOFF_MAX_MS = 30_000;

export class WsClient {
  constructor({ url, onOpen, onClose, onMessage }) {
    this.url = url;
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.onMessage = onMessage || (() => {});
    this.socket = null;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(1000, 'module disabled'); } catch {}
      this.socket = null;
    }
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (!this.isOpen()) {
      console.warn(`[foundry-bridge] cannot send — socket not open. Dropping ${message?.method || 'message'}.`);
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error('[foundry-bridge] send failed:', err);
      return false;
    }
  }

  _connect() {
    if (this.stopped) return;
    let s;
    try {
      s = new WebSocket(this.url);
    } catch (err) {
      console.error('[foundry-bridge] WebSocket constructor threw:', err);
      this._scheduleReconnect();
      return;
    }
    this.socket = s;

    s.addEventListener('open', () => {
      this.attempt = 0;
      try { this.onOpen(); } catch (err) { console.error('[foundry-bridge] onOpen threw:', err); }
    });

    s.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        console.error('[foundry-bridge] dropping malformed frame:', err);
        return;
      }
      try { this.onMessage(msg); } catch (err) { console.error('[foundry-bridge] onMessage threw:', err); }
    });

    s.addEventListener('close', (ev) => {
      this.socket = null;
      try { this.onClose({ code: ev.code, reason: ev.reason }); } catch {}
      if (!this.stopped) this._scheduleReconnect();
    });

    // 'error' is followed by 'close'; reconnect logic lives in the close handler.
    s.addEventListener('error', () => {});
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const idx = Math.min(this.attempt, BACKOFF_SCHEDULE_MS.length - 1);
    const delay = this.attempt < BACKOFF_SCHEDULE_MS.length ? BACKOFF_SCHEDULE_MS[idx] : BACKOFF_MAX_MS;
    this.attempt++;
    console.log(`[foundry-bridge] reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }
}
