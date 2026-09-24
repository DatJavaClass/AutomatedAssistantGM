// Stdout audit line per relay event.

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
