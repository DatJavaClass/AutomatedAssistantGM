/* Reversible console and window logging. */
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
    if (this.installed) return; // already tapped exits, else installs
    for (const level of LEVELS) { // wraps each level, then exits
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
    if (!this.installed) return; // untapped exits, else restores
    for (const level of LEVELS) { // restores each level, then exits
      console[level] = this.originals[level];
    }
    if (this._winErrorHandler) window.removeEventListener('error', this._winErrorHandler); // handler present removes listener
    if (this._winRejectionHandler) window.removeEventListener('unhandledrejection', this._winRejectionHandler); // handler present removes listener
    this.originals = {};
    this._winErrorHandler = null;
    this._winRejectionHandler = null;
    this.installed = false;
  }

  /* False filters drop entries. */
  subscribe(filterFn, callback) {
    const sub = { filterFn, callback };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  _fanout({ level, args, source }) {
    if (this.subscribers.size === 0) return; // no subscribers exits, else builds
    const entry = {
      level,
      timestamp: new Date().toISOString(),
      source: source || 'console',
      message: args.map(stringifyArg).join(' '),
    };
    for (const sub of this.subscribers) { // each subscriber filtered then notified
      try {
        if (sub.filterFn && !sub.filterFn(entry)) continue; // filtered skips, else callback
        sub.callback(entry);
      } catch {}
    }
  }
}

function stringifyArg(a) {
  if (a == null) return String(a); // nullish stringified directly
  if (typeof a === 'string') return a; // strings pass through unchanged
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`; // errors keep name and stack
  try { return JSON.stringify(a); } catch { return String(a); }
}
