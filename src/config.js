import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Detect current user safely.
 * Returns null if numeric UID has no /etc/passwd entry.
 */
export function getCurrentUser() {
  try {
    return os.userInfo();
  } catch {
    return null;
  }
}

/**
 * Resolve a writable, valid HOME directory.
 * Falls back to process.cwd() if os.homedir() throws or doesn't exist.
 */
export function getHomeDir() {
  let home;
  try {
    home = os.homedir();
  } catch {
    home = null;
  }
  if (!home || !fs.existsSync(home)) {
    home = process.cwd();
  }
  return home;
}

function loadDotEnv(env) {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[match[1]] = value;
  }
}

/**
 * Resolve hosting configuration from optional flags and environment values.
 */
export function loadConfig(argv = process.argv, env = process.env) {
  loadDotEnv(env);

  // Parse command line arguments
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--console") {
      flags.console = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--port" && i + 1 < argv.length) {
      flags.port = argv[++i];
    } else if (arg.startsWith("--port=")) {
      flags.port = arg.slice("--port=".length);
    } else if (arg === "--host" && i + 1 < argv.length) {
      flags.host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      flags.host = arg.slice("--host=".length);
    } else if (arg === "--token" && i + 1 < argv.length) {
      flags.token = argv[++i];
    } else if (arg.startsWith("--token=")) {
      flags.token = arg.slice("--token=".length);
    } else if (arg === "--ip-mode" && i + 1 < argv.length) {
      flags.ipMode = argv[++i];
    } else if (arg.startsWith("--ip-mode=")) {
      flags.ipMode = arg.slice("--ip-mode=".length);
    } else if (arg === "--allowed-ips" && i + 1 < argv.length) {
      flags.allowedIps = argv[++i];
    } else if (arg.startsWith("--allowed-ips=")) {
      flags.allowedIps = arg.slice("--allowed-ips=".length);
    } else if (arg === "--log-level" && i + 1 < argv.length) {
      flags.logLevel = argv[++i];
    } else if (arg.startsWith("--log-level=")) {
      flags.logLevel = arg.slice("--log-level=".length);
    }
  }

  // Prefer a hosting-panel port; .env PORT is the local fallback.
  const rawPort = flags.port ?? env.PORT ?? env.SERVER_PORT ?? env.PTYGATE_PORT;
  if (!rawPort) {
    throw new Error("No port configured. Set PORT in the hosting panel or copy .env.example to .env and set PORT.");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${rawPort}". Must be an integer between 1 and 65535.`);
  }

  // Hosted containers must listen on all interfaces for the platform proxy.
  // HOST/PTYGATE_HOST can still override this when intentionally needed.
  let host = flags.host ?? env.HOST;
  if (!host) host = "0.0.0.0";

  // CONSOLE resolution
  // CLI --console > LOCAL_CONSOLE === "1"
  const localConsole = Boolean(flags.console || env.LOCAL_CONSOLE === "1");

  // IP MODE & ALLOWED_IPS
  // Public access is the default for hosted web terminals. The login token
  // remains required; allowlist mode can be explicitly enabled if desired.
  let ipMode = flags.ipMode;
  if (!ipMode) {
    if (env.ALLOW_PRIVATE_ONLY === "1" || env.ALLOW_PRIVATE_ONLY === "true") {
      ipMode = "allowlist";
    } else {
      ipMode = "any";
    }
  }
  if (ipMode !== "allowlist" && ipMode !== "any") {
    throw new Error(`Invalid ip-mode: "${ipMode}". Must be "allowlist" or "any".`);
  }

  const rawAllowedIps = flags.allowedIps ?? env.ALLOWED_IPS ?? "";
  const allowedIps = rawAllowedIps
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // TOKEN resolution
  // CLI --token > TERMINAL_TOKEN > generated
  const tokenEnv = flags.token ?? env.TERMINAL_TOKEN;
  let token = tokenEnv;
  let isGeneratedToken = false;
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    isGeneratedToken = true;
  } else if (token.length < 16) {
    throw new Error("TERMINAL_TOKEN must be at least 16 characters. Refusing to start.");
  }

  // SHELL resolution
  const shell = env.SHELL_BIN || env.SHELL || "/bin/bash";

  // COOKIE SECURE flag
  const secureCookie = env.COOKIE_SECURE === "1";

  // LOG LEVEL
  const logLevel = flags.logLevel ?? "info";

  // CAPACITY & LIMITS
  const sessionTtlMs = 12 * 60 * 60 * 1000; // 12h
  const resumeGraceMs = Number(env.RESUME_GRACE_MS) || 300_000; // 5 min default
  const maxPtysTotal = 8;
  const maxPtysPerSession = 4;
  const maxInputBytes = 64 * 1024; // 64 KiB
  const maxReplayBytes = 262_144; // 256 KiB ring buffer

  const homeDir = getHomeDir();
  const currentUser = getCurrentUser();

  return {
    flags,
    port,
    host,
    localConsole,
    ipMode,
    allowPrivateOnly: ipMode === "allowlist",
    allowedIps,
    token,
    isGeneratedToken,
    shell,
    secureCookie,
    logLevel,
    sessionTtlMs,
    resumeGraceMs,
    maxPtysTotal,
    maxPtysPerSession,
    maxInputBytes,
    maxReplayBytes,
    homeDir,
    currentUser,
  };
}
