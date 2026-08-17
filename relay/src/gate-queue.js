export class GateQueue {
  constructor({ audit }) {
    this.audit = audit;
    this.tail = Promise.resolve();
  }

  async run(label, task) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    this.audit.log('gate.queue.start', { label });
    try { return await task(); }
    finally {
      this.audit.log('gate.queue.end', { label });
      release();
    }
  }
}
