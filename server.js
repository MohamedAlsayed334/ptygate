import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./src/config.js";
import { logger } from "./src/logger.js";
import { AuthManager } from "./src/auth.js";
import { PtyManager } from "./src/pty.js";
import { LocalConsole } from "./src/console.js";
import { createHttpApp } from "./src/http.js";
import { setupWebSocket } from "./src/ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Handle CLI flags like --help or --version early
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("ptygate 0.1.0 (protocol 1)\n");
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    `ptygate - guarded web terminal gateway\n\n` +
      `Usage: node server.js [options]\n\n` +
      `Options:\n` +
      `  --port <num>            Port to listen on (default: $PORT, $SERVER_PORT, or 8080)\n` +
      `  --host <addr>           Host address to bind to (default: 127.0.0.1 or 0.0.0.0)\n` +
      `  --token <token>         Authentication token (min 16 chars)\n` +
      `  --ip-mode <mode>        IP mode: allowlist or any (default: allowlist)\n` +
      `  --allowed-ips <list>    Comma-separated list of allowed IPs or CIDRs\n` +
      `  --console               Bridge local terminal to shell\n` +
      `  --version, -v           Show version information and exit\n` +
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

const app = createHttpApp(config, authManager, ptyManager, __dirname);
const server = http.createServer(app);
const wsHandler = setupWebSocket(server, config, authManager, ptyManager);

function getHostUrls(port, inContainer) {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const containerNet = inContainer || /^(docker|br-|veth|virbr|podman|cni)/.test(name);
      out.push({ name, url: `http://${a.address}:${port}`, containerNet });
    }
  }
  out.sort((a, b) => Number(a.containerNet) - Number(b.containerNet));
  return out;
}

const urls = getHostUrls(config.port, config.inContainer);

server.listen(config.port, config.host, () => {
  logger.log("");
  logger.log(`  web terminal listening on http://${config.host}:${config.port}`);

  const wildcard = config.host === "0.0.0.0" || config.host === "::";
  if (urls.length && wildcard) {
    logger.log("  addresses on this machine:");
    for (const u of urls) {
      logger.log(
        `    ${u.url}${u.containerNet ? `   (${u.name}: container network, not your LAN)` : `   (${u.name})`}`,
      );
    }
  }

  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    logger.log(
      config.allowPrivateOnly
        ? "  LAN mode: only private-network addresses may connect (ALLOW_PRIVATE_ONLY=1)."
        : "  WARNING: ALLOW_PRIVATE_ONLY=0 -- anyone who can route to this port may connect.",
    );
  }

  logger.log(`  access token: ${config.token}${config.isGeneratedToken ? "   (generated for this run)" : ""}`);
  logger.log(`  shell: ${config.shell}`);

  if (config.inContainer) {
    logger.log("");
    logger.log(`  running inside a ${config.inContainer} container. Addresses such as 172.17.x / 172.18.x`);
    logger.log("  only exist inside the container network; another device in your house cannot");
    logger.log("  reach them. To open this from a phone or laptop:");
    logger.log('    docker run -p 8080:8080 ...        or compose:  ports: ["8080:8080"]');
    logger.log("    then use the HOST machine's LAN IP (e.g. http://192.168.1.50:8080)");
    logger.log("    or: docker run --network host ...   (container shares the host's network)");
    logger.log("    or: ssh -L 8080:127.0.0.1:8080 user@host");
  }

  if (!config.currentUser) {
    logger.log("");
    logger.log(`  warning: uid ${process.getuid?.()} has no /etc/passwd entry.`);
    logger.log("  Shells will show 'I have no name!' and whoami/ps will fail.");
    logger.log("  Fix inside the container, as root:");
    logger.log(
      `    echo "user:x:${process.getuid?.()}:${process.getgid?.()}::/home/user:/bin/bash" >> /etc/passwd`,
    );
    logger.log(`    mkdir -p /home/user && chown ${process.getuid?.()}:${process.getgid?.()} /home/user`);
  }
  logger.log("");

  if (config.localConsole) {
    localConsole.start();
  } else {
    logger.log("  tip: run with --console to also get a shell in this terminal.");
    logger.log("");
  }
});

// Protect process from unexpected network errors
process.on("uncaughtException", (err) => {
  logger.log(`[fatal] uncaught exception: ${err?.stack || err}`);
});

// Graceful termination
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    logger.flushLogBuffer();
    process.stderr.write("\nshutting down\n");
    localConsole.stop();
    wsHandler.close();
    ptyManager.destroyAll();
    authManager.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
