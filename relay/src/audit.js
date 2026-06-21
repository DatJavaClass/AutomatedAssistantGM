// Phase 1: stdout-only audit shim. Every command that crosses the relay is
// logged here for protocol debugging. Phase 3 will add a journal-page sink for
// the AAGM channel — at that point this becomes a wrapper around both.

export class Audit {
  constructor({ stdout = true } = {}) {
    this.toStdout = stdout;
  }

  log(event, data = {}) {
    if (!this.toStdout) return;
    const ts = new Date().toISOString();
    let payload;
    try {
      payload = JSON.stringify(data);
    } catch (err) {
      payload = `<unserializable: ${err.message}>`;
    }
    // One line per event so it stays grep-friendly.
    console.log(`${ts} ${event} ${payload}`);
  }
}
