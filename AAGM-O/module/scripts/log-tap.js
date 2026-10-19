/* Reversible console and window logging. */
const LEVELS = ['log', 'info', 'warn', 'error', 'debug']; // captured console levels

export class LogTap {
  constructor() {
    this.installed = false;
    this.originals = {};
    this.subscribers = new Set();
    this._winErrorHandler = null;
    this._winRejectionHandler = null;
  }

  install() {
    if (this.installed) return; // already installed returns, else installs
    for (const level of LEVELS) { // each level wrapped, ends at last
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
    if (!this.installed) return; // not installed returns, else restores
    for (const level of LEVELS) { // each level restored, ends at last
      console[level] = this.originals[level];
    }
    if (this._winErrorHandler) window.removeEventListener('error', this._winErrorHandler); // handler present gets removed
    if (this._winRejectionHandler) window.removeEventListener('unhandledrejection', this._winRejectionHandler); // handler present gets removed
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
    if (this.subscribers.size === 0) return; // no subscribers returns early
    const entry = {
      level,
      timestamp: new Date().toISOString(),
      source: source || 'console',
      message: args.map(stringifyArg).join(' '),
    };
    for (const sub of this.subscribers) { // each subscriber called, ends at last
      try {
        if (sub.filterFn && !sub.filterFn(entry)) continue; // filter rejects, next subscriber
        sub.callback(entry);
      } catch {}
    }
  }
}

function stringifyArg(a) {
  if (a == null) return String(a); // nullish stringified directly
  if (typeof a === 'string') return a; // string passes through
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`; // error prints name, message, stack
  try { return JSON.stringify(a); } catch { return String(a); }
}
