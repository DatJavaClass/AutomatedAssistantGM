// Wraps console.log/info/warn/error/debug and listens for window-level errors
// (window.error, unhandledrejection). Subscribers register a callback that
// receives a normalized log entry. Wrapping is reversible: install() stores
// originals, uninstall() restores them.

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

export class LogTap {
  constructor() {
    this.installed = false;
    this.originals = {};
    this.subscribers = new Set();
    this._winErrorHandler = null;
    this._winRejectionHandler = null;
  }

  install() {
    if (this.installed) return;
    for (const level of LEVELS) {
      const orig = console[level];
      this.originals[level] = orig;
      console[level] = (...args) => {
        try { this._fanout({ level, args }); } catch {}
        return orig.apply(console, args);
      };
    }
    this._winErrorHandler = (ev) => {
      try { this._fanout({ level: 'error', args: [ev.error || ev.message], source: 'window.error' }); } catch {}
    };
    this._winRejectionHandler = (ev) => {
      try { this._fanout({ level: 'error', args: [ev.reason], source: 'unhandledrejection' }); } catch {}
    };
    window.addEventListener('error', this._winErrorHandler);
    window.addEventListener('unhandledrejection', this._winRejectionHandler);
    this.installed = true;
  }

  uninstall() {
    if (!this.installed) return;
    for (const level of LEVELS) {
      console[level] = this.originals[level];
    }
    if (this._winErrorHandler) window.removeEventListener('error', this._winErrorHandler);
    if (this._winRejectionHandler) window.removeEventListener('unhandledrejection', this._winRejectionHandler);
    this.originals = {};
    this._winErrorHandler = null;
    this._winRejectionHandler = null;
    this.installed = false;
  }

  // filterFn is optional; returning false drops the entry for this subscriber.
  subscribe(filterFn, callback) {
    const sub = { filterFn, callback };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  _fanout({ level, args, source }) {
    if (this.subscribers.size === 0) return;
    const entry = {
      level,
      timestamp: new Date().toISOString(),
      source: source || 'console',
      message: args.map(stringifyArg).join(' '),
    };
    for (const sub of this.subscribers) {
      try {
        if (sub.filterFn && !sub.filterFn(entry)) continue;
        sub.callback(entry);
      } catch {}
    }
  }
}

function stringifyArg(a) {
  if (a == null) return String(a);
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}
