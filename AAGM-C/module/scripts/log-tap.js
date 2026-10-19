// Console tap for relay log streaming.

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
    if (this.installed) return; // already installed returns
    for (const level of LEVELS) { // each level wrapped
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
    if (!this.installed) return; // not installed returns
    for (const level of LEVELS) { // each level restored
      console[level] = this.originals[level];
    }
    if (this._winErrorHandler) window.removeEventListener('error', this._winErrorHandler); // error listener removed if set
    if (this._winRejectionHandler) window.removeEventListener('unhandledrejection', this._winRejectionHandler); // rejection listener removed if set
    this.originals = {};
    this._winErrorHandler = null;
    this._winRejectionHandler = null;
    this.installed = false;
  }

  // filterFn optional; false return drops this entry
  subscribe(filterFn, callback) {
    const sub = { filterFn, callback };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  _fanout({ level, args, source }) {
    if (this.subscribers.size === 0) return; // no subscribers returns
    const entry = {
      level,
      timestamp: new Date().toISOString(),
      source: source || 'console',
      message: args.map(stringifyArg).join(' '),
    };
    for (const sub of this.subscribers) { // each subscriber fed
      try {
        if (sub.filterFn && !sub.filterFn(entry)) continue; // filtered entry skips subscriber
        sub.callback(entry);
      } catch {}
    }
  }
}

function stringifyArg(a) {
  if (a == null) return String(a); // nullish prints String(a)
  if (typeof a === 'string') return a; // string passes through
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`; // error prints name and stack
  try { return JSON.stringify(a); } catch { return String(a); }
}
