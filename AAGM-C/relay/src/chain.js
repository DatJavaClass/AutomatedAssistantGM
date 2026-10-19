// Chain Mode grants, confirm policy only.

import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60_000; /* grant lifetime */
const CAPABILITY_SET = 'debug'; /* same routing as prompt-queue */

export class ChainRegistry {
  constructor({ dispatcher, audit, settings }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.settings = settings;
    this.active = null; /* { chainId, count, used, summary, expiresAt } */
    dispatcher.subscribe('claude.chain.cancel', (p) => {
      if (this.active && p?.chainId === this.active.chainId) this.kill('gm-cancel'); // matching chain kills, else ignored
    });
  }

  // Claude offers; GM answers one single-confirm card.
  async offer({ count, summary, tabId }) {
    if (!this.settings.get('chainOffers')) return { refused: true, reason: 'chain-offers-disabled' }; // offers off refuses, else continues
    if (this.active) return { refused: true, reason: 'chain-already-active' }; // active chain refuses, else continues
    const max = this.settings.get('chainMaxLength');
    if (!Number.isInteger(count) || count < 2 || count > max) { // bad count refuses, else continues
      return { refused: true, reason: `count must be an integer 2..${max}` };
    }
    const chainId = `chain-${randomUUID()}`; /* new grant id */
    const decision = await this.dispatcher.requestConfirmation({ /* GM card answer */
      capabilitySet: CAPABILITY_SET, opId: chainId, kind: 'chain', level: 'single', tabId,
      summary: `CHAIN MODE - approve ${count} single-auth gates as one batch:\n${summary}`,
    });
    if (!decision.approved) { // declined refuses, else grants
      this.audit.log('chain.declined', { chainId, reason: decision.reason });
      return { refused: true, reason: decision.reason };
    }
    this.active = { chainId, count, used: 0, summary, expiresAt: Date.now() + TTL_MS, tabId };
    this.audit.log('chain.grant', { chainId, count, summary, tabId });
    this._notify({ event: 'grant', chainId, count, text: summary, tabId });
    return { chainId, count, expiresInSeconds: TTL_MS / 1000 };
  }

  // Gate rides the chain; false = confirm manually.
  consume(chainId, gateSummary) {
    const a = this.active; /* live grant or null */
    if (!a || a.chainId !== chainId) return false; // no match false, else continues
    if (Date.now() > a.expiresAt) { this.kill('ttl-expired'); return false; } // expired kills, else continues
    a.used++;
    this.audit.log('chain.gate', { chainId, n: a.used, of: a.count, summary: gateSummary });
    this._notify({ event: 'gate', chainId, n: a.used, count: a.count, text: gateSummary, tabId: a.tabId });
    if (a.used >= a.count) this.kill('count-exhausted'); // spent kills, Nth gate rides
    return true;
  }

  kill(reason) {
    if (!this.active) return; // idle returns, else ends chain
    const { chainId, used, count, tabId } = this.active;
    this.active = null;
    this.audit.log('chain.end', { chainId, used, count, reason });
    this._notify({ event: 'end', chainId, n: used, count, text: reason, tabId });
  }

  _notify(params) {
    this.dispatcher.notifyBridge({ capabilitySet: CAPABILITY_SET, method: 'claude.chain', params });
  }
}
