// Chain Mode (DESIGN §13.3; ceiling = CLAUDE.md locked decision #8).
// One chain at a time: a GM-approved grant to auto-approve N pre-declared
// SINGLE-auth gates for one homogeneous task. Anything surprising - an
// escalation, an error, a denial, TTL, GM cancel - kills the chain and all
// remaining gates revert to manual confirmation. Only the user authorizes
// destructive changes; this never grows toward Auto Mode.

import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60_000;     /* grant lifetime */
const CAPABILITY_SET = 'debug'; /* same single-bridge routing as prompt-queue */

export class ChainRegistry {
  constructor({ dispatcher, audit, settings }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.settings = settings;
    this.active = null;          /* { chainId, count, used, summary, expiresAt } */
    dispatcher.subscribe('claude.chain.cancel', (p) => {
      if (this.active && p?.chainId === this.active.chainId) this.kill('gm-cancel');
    });
  }

  // Claude proposes a batch; the GM answers at a normal single-confirm card.
  async offer({ count, summary }) {
    if (!this.settings.get('chainOffers')) return { refused: true, reason: 'chain-offers-disabled' };
    if (this.active) return { refused: true, reason: 'chain-already-active' };
    const max = this.settings.get('chainMaxLength');
    if (!Number.isInteger(count) || count < 2 || count > max) {
      return { refused: true, reason: `count must be an integer 2..${max}` };
    }
    const chainId = `chain-${randomUUID()}`;
    const decision = await this.dispatcher.requestConfirmation({
      capabilitySet: CAPABILITY_SET, opId: chainId, kind: 'chain', level: 'single',
      summary: `CHAIN MODE - approve ${count} single-auth gates as one batch:\n${summary}`,
    });
    if (!decision.approved) {
      this.audit.log('chain.declined', { chainId, reason: decision.reason });
      return { refused: true, reason: decision.reason };
    }
    this.active = { chainId, count, used: 0, summary, expiresAt: Date.now() + TTL_MS };
    this.audit.log('chain.grant', { chainId, count, summary });
    this._notify({ event: 'grant', chainId, count, text: summary });
    return { chainId, count, expiresInSeconds: TTL_MS / 1000 };
  }

  // One gate tries to ride the chain. False = confirm manually instead.
  consume(chainId, gateSummary) {
    const a = this.active;
    if (!a || a.chainId !== chainId) return false;
    if (Date.now() > a.expiresAt) { this.kill('ttl-expired'); return false; }
    a.used++;
    this.audit.log('chain.gate', { chainId, n: a.used, of: a.count, summary: gateSummary });
    this._notify({ event: 'gate', chainId, n: a.used, count: a.count, text: gateSummary });
    if (a.used >= a.count) this.kill('count-exhausted'); /* Nth gate still rides */
    return true;
  }

  kill(reason) {
    if (!this.active) return;
    const { chainId, used, count } = this.active;
    this.active = null;
    this.audit.log('chain.end', { chainId, used, count, reason });
    this._notify({ event: 'end', chainId, n: used, count, text: reason });
  }

  _notify(params) {
    this.dispatcher.notifyBridge({ capabilitySet: CAPABILITY_SET, method: 'claude.chain', params });
  }
}
