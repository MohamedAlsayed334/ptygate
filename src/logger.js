import util from "node:util";

class Logger {
  constructor() {
    this.consoleActive = false;
    this.logBuffer = [];
    this.maxBuffer = 200;
  }

  setConsoleActive(active) {
    this.consoleActive = Boolean(active);
  }

  log(...args) {
    const line = util.format(...args);
    if (this.consoleActive) {
      this.logBuffer.push(line);
      if (this.logBuffer.length > this.maxBuffer) {
        this.logBuffer.shift();
      }
      return;
    }
    // Always write to stderr so stdout remains clean for PTY or piped output
    process.stderr.write(line + "\n");
  }

  flushLogBuffer() {
    if (!this.logBuffer.length) return;
    process.stderr.write("\n--- server log while the local shell was open ---\n");
    for (const line of this.logBuffer) {
      process.stderr.write(line + "\n");
    }
    process.stderr.write("--- end of buffered log ---\n\n");
    this.logBuffer.length = 0;
  }
}

export const logger = new Logger();
