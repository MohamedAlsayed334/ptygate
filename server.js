import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./src/config.js";
import { logger } from "./src/logger.js";
import { AuthManager } from "./src/auth.js";
import { PtyManager } from "./src/pty.js";
import { LocalConsole } from "./src/console.js";
import { setupWebSocket } from "./src/ws.js";
import { createModuleHost } from "./src/modules.js";
import { normalizeIp } from "./src/ip_policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Handle CLI help before starting the server.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    `ptygate - browser web terminal\n\n` +
      `Usage: node server.js [options]\n\n` +
      `Options:\n` +
      `  --port <num>            Port to listen on (or set PORT / SERVER_PORT)\n` +
      `  --host <addr>           Host address to bind to (default: 0.0.0.0)\n` +
      `  --token <token>         Authentication token (min 16 chars)\n` +
      `  --ip-mode <mode>        IP mode: allowlist or any (default: any)\n` +
      `  --allowed-ips <list>    Optional comma-separated IP/CIDR allowlist\n` +
      `  --console               Bridge local terminal to shell\n` +
      `  --help, -h              Show this help message and exit\n`,
  );
  process.exit(0);
}

let config;
try {
  config = loadConfig(process.argv, process.env);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}

const authManager = new AuthManager(config);
const ptyManager = new PtyManager(config);
const localConsole = new LocalConsole(config);

const server = http.createServer();
const wsHandler = setupWebSocket(server, config, authManager, ptyManager);
const services = {
  registerWebSocket: (route, handler, owner) => wsHandler.register(route, handler, owner),
  activateWebSocket: (route) => wsHandler.activate(route),
  forModule(id) {
    if (id === "terminal") {
      return {
        authManager,
        ptyManager,
        normalizeIp,
        terminalWebSocket: (req, socket, head) => wsHandler.terminalHandler(req, socket, head),
      };
    }
    return {};
  },
};
const host = await createModuleHost(config, services, __dirname);
const app = host.app;
server.on("request", app);
server.on("upgrade", (req, socket, head) => {
  if (host.handleUpgrade(req, socket, head)) return;
});

server.listen(config.port, config.host, () => {
  logger.log(`Web terminal listening on ${config.host}:${config.port}`);
  logger.log(`Access token: ${config.token}${config.isGeneratedToken ? " (generated for this run)" : ""}`);
  logger.log(`Shell: ${config.shell}`);

  if (!config.currentUser) {
    logger.log("");
    logger.log(`  warning: uid ${process.getuid?.()} has no /etc/passwd entry.`);
    logger.log("  Shells will show 'I have no name!' and whoami/ps will fail.");
  }
  logger.log("");

  if (config.localConsole) {
    localConsole.start();
  }
});

// Protect process from unexpected network errors
process.on("uncaughtException", (err) => {
  logger.log(`[fatal] uncaught exception: ${err?.stack || err}`);
});

// Graceful termination
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    logger.flushLogBuffer();
    process.stderr.write("\nshutting down\n");
    localConsole.stop();
    wsHandler.close();
    await host.close().catch((err) => logger.log(`[shutdown] module cleanup failed: ${err?.message || err}`));
    ptyManager.destroyAll();
    authManager.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
