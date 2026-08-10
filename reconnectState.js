import EventEmitter from 'events';
export class ReconnectStateMachine extends EventEmitter {
  constructor({ maxAttempts = 10, baseDelay = 1000, maxDelay = 30000, jitter = true } = {}) {
    super();
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.jitter = jitter;
    this.attempt = 0;
    this.timer = null;
    this.state = 'idle';
    this._disconnected = false;
  }
  reset() {
    this.attempt = 0;
    this.state = 'idle';
    this._disconnected = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  connected() {
    this.state = 'connected';
    this.attempt = 0;
    this._disconnected = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  disconnected() {
    if (this._disconnected) return;
    this._disconnected = true;
    this.state = 'reconnecting';
    if (this.attempt >= this.maxAttempts) {
      this.state = 'failed';
      this.emit('failed');
      return;
    }
    const delay = Math.min(this.baseDelay * Math.pow(2, this.attempt), this.maxDelay);
    const jitterFactor = this.jitter ? (0.5 + Math.random()) : 1;
    const actualDelay = delay * jitterFactor;
    this.attempt++;
    this.timer = setTimeout(() => {
      this.emit('reconnecting', this.attempt);
    }, actualDelay);
  }
  failed() {
    this.state = 'failed';
    this.emit('failed');
  }
}
