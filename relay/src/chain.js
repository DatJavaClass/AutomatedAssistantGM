import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60_000;

export class ChainRegistry {
  constructor({ dispatcher, audit, settings, capabilitySet }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.settings = settings;
    this.capabilitySet = capabilitySet;
    this.active = null;
    this.declined = new Set();
    this.timer = null;
    dispatcher.subscribe('aagm.chain.cancel', (params) => {
      if (this.active && params?.chainId === this.active.chainId) this.kill('gm-cancel');
    });
  }

  async offer({ count, summary }) {
    const text = String(summary || '').trim();
    if (!this.settings.get('chainOffers')) return { refused: true, reason: 'chain-offers-disabled' };
    if (this.active) return { refused: true, reason: 'chain-already-active' };
    if (!text) return { refused: true, reason: 'summary-required' };
    if (this.declined.has(text)) return { refused: true, reason: 'batch-already-declined' };
    const min = this.settings.get('chainOfferThreshold');
    const max = this.settings.get('chainMaxLength');
    if (!Number.isInteger(count) || count < min || count > max) {
      return { refused: true, reason: `count must be an integer ${min}..${max}` };
    }
    const chainId = `chain-${randomUUID()}`;
    const decision = await this.dispatcher.requestConfirmation({
      capabilitySet: this.capabilitySet,
      opId: chainId,
      kind: 'chain',
      level: 'single',
      summary: `CHAIN MODE: approve ${count} single-auth gates as one batch:\n${text}`,
    });
    if (!decision.approved) {
      this.declined.add(text);
      this.audit.log('chain.declined', { chainId, reason: decision.reason });
      return { refused: true, reason: decision.reason };
    }
    this.active = { chainId, count, used: 0, summary: text, expiresAt: Date.now() + TTL_MS };
    this.timer = setTimeout(() => this.kill('ttl-expired'), TTL_MS);
    this.timer.unref?.();
    this.audit.log('chain.grant', { chainId, count, summary: text });
    this._notify({ event: 'grant', chainId, count, text });
    return { chainId, count, expiresInSeconds: TTL_MS / 1000 };
  }

  consume(chainId, gateSummary) {
    const active = this.active;
    if (!active) return false;
    if (!chainId || active.chainId !== chainId) {
      this.kill('off-manifest-gate');
      return false;
    }
    if (Date.now() > active.expiresAt) {
      this.kill('ttl-expired');
      return false;
    }
    if (active.used >= active.count) {
      this.kill('count-exhausted');
      return false;
    }
    active.used++;
    this.audit.log('chain.gate', { chainId, n: active.used, of: active.count, summary: gateSummary });
    this._notify({ event: 'gate', chainId, n: active.used, count: active.count, text: gateSummary });
    return true;
  }

  complete(chainId) {
    if (this.active?.chainId === chainId && this.active.used >= this.active.count) {
      this.kill('count-exhausted');
    }
  }

  kill(reason) {
    if (!this.active) return;
    const { chainId, used, count } = this.active;
    this.active = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.audit.log('chain.end', { chainId, used, count, reason });
    this._notify({ event: 'end', chainId, n: used, count, text: reason });
  }

  _notify(params) {
    this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.chain', params });
  }
}
