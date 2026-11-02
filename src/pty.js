import pty from "node-pty";
import { logger } from "./logger.js";

/**
 * Manages an individual PTY instance with a bounded ring buffer for session resume.
 */
export class PtyInstance {
  constructor(sessionId, config, initialCols = 80, initialRows = 24) {
    this.sessionId = sessionId;
    this.config = config;
    this.cols = Math.max(20, Math.min(500, initialCols));
    this.rows = Math.max(5, Math.min(200, initialRows));

    this.activeWs = null;
    this.graceTimer = null;
    this.killTimer = null;
    this.closed = false;

    // Ring buffer of chunks
    this.ringBuffer = [];
    this.ringBufferBytes = 0;
    this.maxReplayBytes = config.maxReplayBytes || 262_144; // 256 KiB

    this.onExitCallbacks = new Set();

    this.spawnPty();
  }

  spawnPty() {
    this.term = pty.spawn(this.config.shell, ["-l"], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.config.homeDir,
      env: {
        ...process.env,
        HOME: this.config.homeDir,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "C.UTF-8",
      },
    });

    this.pid = this.term.pid;

    this.term.onData((data) => {
      this.appendBuffer(data);
      if (this.activeWs && this.activeWs.readyState === 1 /* OPEN */) {
        this.activeWs.send(JSON.stringify({ type: "output", data }));
      }
    });

    this.term.onExit(({ exitCode, signal }) => {
      this.handleProcessExit(exitCode, signal);
    });
  }

  appendBuffer(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    this.ringBuffer.push(buf);
    this.ringBufferBytes += buf.length;

    while (this.ringBufferBytes > this.maxReplayBytes && this.ringBuffer.length > 0) {
      const excess = this.ringBufferBytes - this.maxReplayBytes;
      const first = this.ringBuffer[0];
      if (first.length <= excess) {
        this.ringBuffer.shift();
        this.ringBufferBytes -= first.length;
      } else {
        this.ringBuffer[0] = first.subarray(excess);
        this.ringBufferBytes -= excess;
        break;
      }
    }
  }

  getReplayString() {
    if (!this.ringBuffer.length) return "";
    return Buffer.concat(this.ringBuffer).toString("utf8");
  }

  attach(ws) {
    this.clearTimers();

    if (this.activeWs && this.activeWs !== ws) {
      // Replaced by newer socket
      const old = this.activeWs;
      this.activeWs = null;
      try {
        old.close(4000, "detached");
      } catch {
        /* ignore */
      }
    }

    this.activeWs = ws;
  }

  detach() {
    this.activeWs = null;
    this.startGraceTimer();
  }

  write(data) {
    if (this.term && !this.closed) {
      try {
        this.term.write(data);
      } catch {
        /* pty gone */
      }
    }
  }

  resize(cols, rows) {
    this.cols = Math.max(20, Math.min(500, Number(cols) || 80));
    this.rows = Math.max(5, Math.min(200, Number(rows) || 24));
    if (this.term && !this.closed) {
      try {
        this.term.resize(this.cols, this.rows);
      } catch {
        /* pty gone */
      }
    }
  }

  startGraceTimer() {
    this.clearTimers();
    if (this.closed) return;

    this.graceTimer = setTimeout(() => {
      logger.log(`[pty] resume grace expired for sid=${this.sessionId}, terminating pid=${this.pid}`);
      this.destroy();
    }, this.config.resumeGraceMs);
    this.graceTimer.unref?.();
  }

  clearTimers() {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  handleProcessExit(exitCode, signal) {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();

    const signame = signal ? String(signal).replace(/^SIG/, "") : "";
    if (this.activeWs && this.activeWs.readyState === 1 /* OPEN */) {
      try {
        this.activeWs.send(JSON.stringify({
          type: "exit",
          code: exitCode ?? 0,
          signal: signame,
          exitCode: exitCode ?? 0, // compatibility
        }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          this.activeWs?.close(1000, "");
        } catch {
          /* ignore */
        }
      }, 50);
    }

    for (const cb of this.onExitCallbacks) {
      try {
        cb(this);
      } catch {
        /* ignore */
      }
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();

    if (this.term) {
      try {
        this.term.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.killTimer = setTimeout(() => {
        try {
          this.term?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000);
      this.killTimer.unref?.();
    }

    for (const cb of this.onExitCallbacks) {
      try {
        cb(this);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Manages the collection of all live and detached PTYs.
 */
export class PtyManager {
  constructor(config) {
    this.config = config;
    /** @type {Map<string, PtyInstance>} */
    this.ptysBySession = new Map();
  }

  getPtyCount() {
    return this.ptysBySession.size;
  }

  getPtyForSession(sessionId) {
    return this.ptysBySession.get(sessionId) || null;
  }

  hasCapacity() {
    return this.ptysBySession.size < this.config.maxPtysTotal;
  }

  createPty(sessionId, cols, rows) {
    if (this.ptysBySession.has(sessionId)) {
      return this.ptysBySession.get(sessionId);
    }
    if (!this.hasCapacity()) {
      return null;
    }

    const instance = new PtyInstance(sessionId, this.config, cols, rows);
    this.ptysBySession.set(sessionId, instance);

    instance.onExitCallbacks.add((inst) => {
      this.ptysBySession.delete(sessionId);
      logger.log(`[pty] closed pid=${inst.pid} for session ${sessionId.slice(0, 8)}...`);
    });

    return instance;
  }

  destroySessionPty(sessionId) {
    const inst = this.ptysBySession.get(sessionId);
    if (inst) {
      inst.destroy();
      this.ptysBySession.delete(sessionId);
    }
  }

  destroyAll() {
    for (const inst of this.ptysBySession.values()) {
      inst.destroy();
    }
    this.ptysBySession.clear();
  }
}
