import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Detect if we are running inside a container (Docker, Podman, LXC, Pterodactyl, etc.).
 * @returns {string|null} Container runtime type or null if not in container.
 */
export function detectContainer() {
  try {
    if (fs.existsSync("/.dockerenv")) return "docker";
    if (fs.existsSync("/run/.containerenv")) return "podman";
    if (fs.existsSync("/proc/1/cgroup")) {
      const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
      if (/(docker|kubepods|containerd|lxc|pterodactyl)/.test(cgroup)) return "container";
    }
  } catch {
    /* not a container or unreadable */
  }
  return null;
}

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

/**
 * Parse and resolve full configuration with precedence and defaults:
 * Precedence:
 * 1. CLI flags
 * 2. Canonical environment variables (PTYGATE_*)
 * 3. Legacy environment variables (PORT, SERVER_PORT, HOST, LAN, ALLOW_PRIVATE_ONLY, ALLOWED_IPS, TERMINAL_TOKEN, LOCAL_CONSOLE)
 * 4. Stored config or defaults
 */
export function loadConfig(argv = process.argv, env = process.env) {
  const inContainer = detectContainer();

  // Parse command line arguments
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--console") {
      flags.console = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
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

  // PORT resolution
  // CLI --port > PTYGATE_PORT > PORT > SERVER_PORT > 8080
  const rawPort = flags.port ?? env.PTYGATE_PORT ?? env.PORT ?? env.SERVER_PORT ?? "8080";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${rawPort}". Must be an integer between 1 and 65535.`);
  }

  // HOST resolution
  // CLI --host > PTYGATE_HOST > HOST > (LAN=1 => 0.0.0.0) > (inContainer => 0.0.0.0) > 127.0.0.1
  const wantLan = env.LAN === "1" || env.LAN === "true";
  let host = flags.host ?? env.PTYGATE_HOST ?? env.HOST;
  if (!host) {
    if (wantLan || inContainer) {
      host = "0.0.0.0";
    } else {
      host = "127.0.0.1";
    }
  }

  // CONSOLE resolution
  // CLI --console > LOCAL_CONSOLE === "1"
  const localConsole = Boolean(flags.console || env.LOCAL_CONSOLE === "1");

  // IP MODE & ALLOWED_IPS
  // ALLOW_PRIVATE_ONLY="0" means "any", default is "allowlist"
  // CLI --ip-mode > PTYGATE_IP_MODE > (ALLOW_PRIVATE_ONLY="0" ? "any" : "allowlist")
  let ipMode = flags.ipMode ?? env.PTYGATE_IP_MODE;
  if (!ipMode) {
    if (env.ALLOW_PRIVATE_ONLY === "0") {
      ipMode = "any";
    } else {
      ipMode = "allowlist";
    }
  }
  if (ipMode !== "allowlist" && ipMode !== "any") {
    throw new Error(`Invalid ip-mode: "${ipMode}". Must be "allowlist" or "any".`);
  }

  const rawAllowedIps = flags.allowedIps ?? env.PTYGATE_ALLOWED_IPS ?? env.ALLOWED_IPS ?? "";
  const allowedIps = rawAllowedIps
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // TOKEN resolution
  // CLI --token > PTYGATE_TOKEN > TERMINAL_TOKEN > generated
  const tokenEnv = flags.token ?? env.PTYGATE_TOKEN ?? env.TERMINAL_TOKEN;
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
  const logLevel = flags.logLevel ?? env.PTYGATE_LOG_LEVEL ?? "info";

  // CAPACITY & LIMITS
  const sessionTtlMs = 12 * 60 * 60 * 1000; // 12h
  const resumeGraceMs = Number(env.RESUME_GRACE_MS) || 300_000; // 5 min default
  const maxPtysTotal = 4; // protocol limit is 4 concurrent PTYs total
  const maxPtysPerSession = 1; // 1 PTY per session at a time
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
    inContainer,
  };
}
