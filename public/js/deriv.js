/*
 * Small WebSocket client for Deriv's options gateway.
 *  - getUrl() is called on every (re)connect, so an authenticated socket can
 *    fetch a fresh single-use OTP URL each time.
 *  - send() returns a promise matched on req_id.
 *  - Every message is also handed to onMessage for stream routing.
 */
(function (root) {
  'use strict';

  class DerivSocket {
    constructor(name, getUrl, { onMessage, onOpen, onStatus } = {}) {
      this.name = name;
      this.getUrl = getUrl;
      this.onMessage = onMessage || (() => {});
      this.onOpen = onOpen || (() => {});
      this.onStatus = onStatus || (() => {});
      this.ws = null;
      this.reqId = 0;
      this.pending = new Map();
      this.closedByUs = false;
      this.retry = 0;
      this.pingTimer = null;
      this.retryTimer = null;
      this.meta = {};
    }

    get isOpen() {
      return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    async connect() {
      this.closedByUs = false;
      clearTimeout(this.retryTimer);
      this.onStatus('connecting');
      let url;
      try {
        url = await this.getUrl();
      } catch (err) {
        this.onStatus('error', err.message || String(err));
        if (err && err.fatal) return;
        this.scheduleReconnect();
        return;
      }
      this.meta.url = url;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.retry = 0;
        this.onStatus('open');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.isOpen) this.ws.send(JSON.stringify({ ping: 1 }));
        }, 30000);
        try { this.onOpen(); } catch (e) { console.error(e); }
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const p = msg.req_id !== undefined ? this.pending.get(msg.req_id) : null;
        if (p && !p.stream) {
          this.pending.delete(msg.req_id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message || msg.error.code || 'Request failed'), { code: msg.error.code, msg }));
          else p.resolve(msg);
        }
        try { this.onMessage(msg); } catch (e) { console.error(e); }
      };

      ws.onclose = () => {
        clearInterval(this.pingTimer);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Connection closed'));
        }
        this.pending.clear();
        if (this.ws !== ws) return; // replaced by a newer socket
        if (this.closedByUs) {
          this.onStatus('closed');
        } else {
          this.onStatus('reconnecting');
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => { /* onclose follows */ };
    }

    scheduleReconnect() {
      if (this.closedByUs) return;
      const delays = [1000, 2000, 4000, 8000, 15000];
      const wait = delays[Math.min(this.retry, delays.length - 1)];
      this.retry++;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), wait);
    }

    send(req, { timeout = 20000 } = {}) {
      if (!this.isOpen) return Promise.reject(new Error(`${this.name} connection is not open`));
      const id = ++this.reqId;
      const payload = Object.assign({}, req, { req_id: id });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Request timed out'));
        }, timeout);
        this.pending.set(id, { resolve, reject, timer });
        this.ws.send(JSON.stringify(payload));
      });
    }

    // Fire-and-forget (used for stream subscriptions; replies arrive via onMessage).
    post(req) {
      if (!this.isOpen) return false;
      this.ws.send(JSON.stringify(Object.assign({}, req, { req_id: ++this.reqId })));
      return true;
    }

    close() {
      this.closedByUs = true;
      clearTimeout(this.retryTimer);
      clearInterval(this.pingTimer);
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
      }
    }
  }

  root.DerivSocket = DerivSocket;
})(window);
