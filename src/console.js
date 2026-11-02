import pty from "node-pty";
import { logger } from "./logger.js";

/**
 * Bridges the server's local interactive terminal (stdin/stdout) to a local PTY shell.
 * Enables running `--console` in panel environments without corrupting output.
 */
export class LocalConsole {
  constructor(config) {
    this.config = config;
    this.session = null;
    this.starting = false;
  }

  start() {
    if (this.starting || this.session) return;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      logger.log("  --console needs an interactive terminal; running headless instead.");
      return;
    }

    this.starting = true;
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;

    let term;
    try {
      term = pty.spawn(this.config.shell, ["-l"], {
        name: process.env.TERM || "xterm-256color",
        cols,
        rows,
        cwd: this.config.homeDir,
        env: {
          ...process.env,
          HOME: this.config.homeDir,
          TERM: process.env.TERM || "xterm-256color",
          LANG: process.env.LANG || "C.UTF-8",
        },
      });
    } catch (err) {
      logger.log(`  failed to spawn local console: ${err?.message || err}`);
      this.starting = false;
      return;
    }

    this.session = term;
    logger.log(`[console] local shell pid=${term.pid} -- keystrokes go to this shell; type "exit" to come back`);

    // Activate logger buffering while local console owns the terminal
    logger.setConsoleActive(true);
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      /* ignore if not supported */
    }

    const onStdin = (chunk) => {
      try {
        term.write(chunk.toString());
      } catch {
        /* pty gone */
      }
    };
    process.stdin.on("data", onStdin);

    const onPtyData = (data) => process.stdout.write(data);
    term.onData(onPtyData);

    const onResize = () => {
      if (!process.stdout.columns) return;
      try {
        term.resize(process.stdout.columns, process.stdout.rows || 30);
      } catch {
        /* pty gone */
      }
    };
    process.stdout.on("resize", onResize);

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      logger.setConsoleActive(false);
      this.session = null;
      this.starting = false;
      process.stdin.off("data", onStdin);
      process.stdout.off("resize", onResize);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not a tty anymore */
      }
      process.stdin.pause();
    };

    term.onExit(() => {
      restore();
      logger.flushLogBuffer();
      process.stderr.write(
        "\n  local shell exited. The web server is still running.\n" +
          "  press Enter for a new shell, or Ctrl+C to stop the server.\n",
      );
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.pause();
        this.start();
      });
    });

    this.starting = false;
  }

  stop() {
    if (this.session) {
      try {
        this.session.kill();
      } catch {
        /* ignore */
      }
      this.session = null;
    }
  }
}
