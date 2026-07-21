// Stdout-only audit shim until Phase 3 journal sink.

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
    console.log(`${ts} ${event} ${payload}`); // one line per event, grep-friendly
  }
}
