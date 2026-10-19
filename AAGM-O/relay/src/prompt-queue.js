/* Long-poll Foundry chat queue. */

import { existsSync, rmSync } from 'node:fs';
import { truncateForLog } from './audit.js';

const LISTENER_TIMEOUT_MS = 45_000; // listener idle window
const SWEEP_INTERVAL_MS = 10_000; // sweep tick interval
const LONG_POLL_TIMEOUT_MS = 25_000; // long poll cap
const TERMINATORS = new Set(['/exit', '/stop', '/quit']); // DESIGN §10 stop words

const TAB_CLOSE = '/close'; // tab close command
const INTERACTION_COMMANDS = new Map([['/int', 'internal'], ['/ext', 'external']]); // mode switch commands

export class PromptQueue {
  constructor({ dispatcher, audit, stopFilePath, capabilitySet, tabs }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.stopFilePath = stopFilePath;
    this.capabilitySet = capabilitySet;
    this.tabs = tabs;
    this.interactionMode = 'internal';
    this.queue = [];
    this.parked = []; // prompts held while in external mode
    this.terminate = false;
    this.listenerLastSeen = 0;
    this.listenerActive = false;
    this.activeListenerId = null;
    this._sweep = null;
    this._waiters = new Set(); // in-flight long-poll resolvers

    tabs.onClose = (tabId) => {
      this.queue.push({ promptId: `close-${tabId}-${Date.now()}`, text: TAB_CLOSE, tabId, close: true, ts: new Date().toISOString() });
      this.audit.log('chat.close', { tabId });
      this._wake();
    };

    dispatcher.subscribe('aagm.prompt', (p) => this._onPrompt(p || {}));
    dispatcher.subscribe('aagm.status.request', () => {
      this._broadcastStatus();
      this._broadcastMode();
    });
  }

  start() {
    if (this._sweep) return; // running sweep returns, else starts
    /* Expire quiet listeners. */
    this._sweep = setInterval(() => {
      this._checkStopFile(); // catch .loop-stop mid-idle, not next timeout
      if (this.terminate) this._wake(); // terminate set wakes pollers
      if (this.listenerActive && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS) { // quiet listener expires and broadcasts
        this._deactivate();
        this._broadcastStatus();
      }
    }, SWEEP_INTERVAL_MS);
    this._sweep.unref?.();
  }

  stop() {
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null; } // sweep running stops and clears
  }

  _onPrompt({ promptId, text, tabId }) {
    const trimmed = (text || '').trim();
    const command = trimmed.toLowerCase();
    if (TERMINATORS.has(command)) { // stop word terminates, returns
      this.terminate = true;
      this.tabs.reset('terminate');
      this.audit.log('chat.terminate', { via: command });
      this._broadcastStatus();
      this._wake();
      return;
    }
    if (command === TAB_CLOSE) { // close command closes tab, returns
      if (this.tabs.tabs.has(tabId)) this.tabs.close(tabId); // known tab closes, unknown ignored
      return;
    }
    if (INTERACTION_COMMANDS.has(command)) { // mode command switches mode, returns
      this.setInteractionMode(INTERACTION_COMMANDS.get(command), command);
      this._broadcastMode();
      return;
    }
    if (this.interactionMode === 'external') { // external mode ignores prompt, returns
      this.audit.log('chat.external.ignored', { promptId, tabId, text: truncateForLog(text ?? '') });
      this._broadcastMode();
      return;
    }
    const interrupt = this.tabs.isWorking(tabId);
    const id = this.tabs.prompt(tabId, text ?? '');
    this.queue.push({ promptId: promptId || `p-${Date.now()}`, text: text ?? '', tabId: id, ...(interrupt ? { interrupt: true } : {}), ts: new Date().toISOString() });
    this.audit.log('chat.in', { promptId, tabId: id, interrupt, text: truncateForLog(text ?? '') });
    this._broadcastStatus(); // reflect listener presence as the user types
    this._wake(); // release any in-flight long-poll immediately
  }

  /* Check the local kill file. */
  _checkStopFile() {
    if (!this.stopFilePath || !existsSync(this.stopFilePath)) return; // no stop file returns
    if (!this.terminate) { // first stop file hit sets terminate
      this.terminate = true;
      this.tabs.reset('terminate');
      this.audit.log('chat.terminate', { via: '.loop-stop' });
    }
    try { rmSync(this.stopFilePath); } catch { /* best-effort; flag already set */ }
  }

  _wake() {
    if (this._waiters.size === 0) return; // no waiters returns
    for (const w of [...this._waiters]) w(); // each waiter released
  }

  /* Claim the single listener slot. */
  claimListener(listenerId) {
    const expired = this.activeListenerId && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS;
    if (expired) this._deactivate(); // expired slot cleared
    if (this.activeListenerId && listenerId !== this.activeListenerId) return false; // other owner refused, same owner renews
    this.activeListenerId = listenerId;
    this.listenerLastSeen = Date.now();
    this._activate();
    return true;
  }

  /* Wait for work or timeout. */
  async waitForWork({ timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
    this._checkStopFile();
    if (this.terminate || this.queue.length) return; // work pending skips the wait
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; // repeat finish ignored
        settled = true;
        clearTimeout(timer);
        this._waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this._waiters.add(finish);
    });
  }

  /* Draining activates listener status. */
  drain() {
    this.listenerLastSeen = Date.now();
    this._activate();
    this._checkStopFile();
    /* Consume termination once. */
    const terminate = this.terminate;
    this.terminate = false;
    if (terminate) { // consumed terminate frees listener slot
      this._deactivate();
      this.tabs.reset('terminate');
      this._broadcastStatus();
    }
    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate, mode: this.interactionMode };
  }

  /* Consume pending interrupts for one tab. */
  drainInterrupts(tabId) {
    const prompts = [];
    this.queue = this.queue.filter((prompt) => { // keeps others, collects tab interrupts
      if (!prompt.interrupt || prompt.tabId !== tabId) return true; // other prompts stay, interrupts collected
      prompts.push(prompt);
      return false;
    });
    return prompts;
  }

  setInteractionMode(mode, via = 'relay') {
    if (mode !== 'internal' && mode !== 'external') return false; // invalid mode returns false
    const prev = this.interactionMode;
    this.interactionMode = mode;
    if (mode === 'external') { // external parks, internal unparks
      this.tabs.settle('external-mode');
      const parked = this.queue.filter((prompt) => !prompt.close); // non close prompts parked
      this.queue = this.queue.filter((prompt) => prompt.close); // keeps only close prompts
      if (parked.length) { // parked prompts held and logged
        this.parked.push(...parked);
        this.audit.log('chat.external.parked', { count: parked.length });
      }
    } else if (prev === 'external' && this.parked.length) { // leaving external restores parked prompts
      this.queue = [...this.parked.splice(0), ...this.queue];
      this.audit.log('chat.internal.unparked', { count: this.queue.length });
    }
    this.audit.log('chat.mode', { mode, via });
    this._wake();
    return true;
  }

  status() {
    return { state: this.listenerActive ? 'ready' : 'no-listener' };
  }

  _activate() {
    if (this.listenerActive) return; // already active returns
    this.listenerActive = true;
    this._broadcastStatus();
  }

  _deactivate() {
    this.listenerActive = false;
    this.activeListenerId = null;
  }

  _broadcastStatus() {
    /* Foundry detects disconnection locally. */
    this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.status', params: this.status() });
  }

  _broadcastMode() {
    this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.mode', params: { mode: this.interactionMode } });
  }
}
