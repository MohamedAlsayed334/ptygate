import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import util from "node:util";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT || 8080);

// Reachable from:
//   Loopback is the safe default. `LAN=1` (or an explicit HOST) binds all
//   interfaces so phones/laptops on the same wifi can connect.
const WANT_LAN = process.env.LAN === "1" || process.env.LAN === "true";
const HOST = process.env.HOST || (WANT_LAN ? "0.0.0.0" : "127.0.0.1");

// `--console` puts you in a shell in *this* terminal, alongside the web UI.
const LOCAL_CONSOLE =
  process.argv.includes("--console") || process.env.LOCAL_CONSOLE === "1";

// In LAN mode, only private/LAN addresses may connect unless you override it.
// This means "reachable from my house, not from the internet".
const ALLOW_PRIVATE_ONLY = process.env.ALLOW_PRIVATE_ONLY !== "0";
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHELL = process.env.SHELL_BIN || process.env.SHELL || "/bin/bash";
const SECURE_COOKIE = process.env.COOKIE_SECURE === "1";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_PTYS_TOTAL = 8;
const MAX_PTYS_PER_SESSION = 4;
const MAX_INPUT_BYTES = 64 * 1024;

/* ----------------------------------------------------------------- logging */

// While the local console owns the terminal, stray log lines would corrupt it.
// Buffer them and print on exit instead.
let consoleActive = false;
const logBuffer = [];
const MAX_LOG_BUFFER = 200;

function log(...args) {
  const line = util.format(...args);
  if (consoleActive) {
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
    return;
  }
  // Always stderr so stdout stays clean for the PTY bridge.
  process.stderr.write(line + "\n");
}

function flushLogBuffer() {
  if (!logBuffer.length) return;
  process.stderr.write("\n--- server log while the local shell was open ---\n");
  for (const line of logBuffer) process.stderr.write(line + "\n");
  process.stderr.write("--- end of buffered log ---\n\n");
  logBuffer.length = 0;
}

const TOKEN_ENV = process.env.TERMINAL_TOKEN;
let TOKEN = TOKEN_ENV;
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString("base64url");
} else if (TOKEN.length < 16) {
  process.stderr.write("TERMINAL_TOKEN must be at least 16 characters. Refusing to start.\n");
  process.exit(1);
}

/* ------------------------------------------------------------ environment */

function detectContainer() {
  try {
    if (fs.existsSync("/.dockerenv")) return "docker";
    if (fs.existsSync("/run/.containerenv")) return "podman";
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/(docker|kubepods|containerd|lxc)/.test(cgroup)) return "container";
  } catch {
    /* not a container, or unreadable */
  }
  return null;
}

const IN_CONTAINER = detectContainer();

let CURRENT_USER = null;
try {
  CURRENT_USER = os.userInfo();
} catch {
  CURRENT_USER = null; // uid has no /etc/passwd entry
}

// os.homedir() can throw (or point at a missing dir) when the uid is unknown,
// which would make pty.spawn fail. Fall back to the working directory.
let HOME_DIR;
try {
  HOME_DIR = os.homedir();
} catch {
  HOME_DIR = null;
}
if (!HOME_DIR || !fs.existsSync(HOME_DIR)) HOME_DIR = process.cwd();

/* -------------------------------------------------------- ip / network guard */

function normalizeIp(raw) {
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function cidrMatch(ip, cidr) {
  const slash = cidr.indexOf("/");
  const base = slash === -1 ? cidr : cidr.slice(0, slash);
  const bits = slash === -1 ? 32 : Number(cidr.slice(slash + 1));
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

const PRIVATE_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local
  "100.64.0.0/10", // CGNAT (also what Tailscale hands out)
];

function isPrivateIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  if (ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    // unique-local (fc00::/7) and link-local (fe80::/10)
    return /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
  }
  return PRIVATE_V4.some((c) => cidrMatch(ip, c));
}

function ipAllowed(raw) {
  const ip = normalizeIp(raw);
  if (ALLOWED_IPS.length > 0) {
    return ALLOWED_IPS.some((entry) =>
      entry.includes("/") ? cidrMatch(ip, entry) : normalizeIp(entry) === ip,
    );
  }
  if (ALLOW_PRIVATE_ONLY) return isPrivateIp(ip);
  return true;
}

/* ---------------------------------------------------------------- sessions */

/** @type {Map<string, {created:number, seen:number}>} */
const sessions = new Map();

function createSession() {
  const sid = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(sid, { created: now, seen: now });
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.seen > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  s.seen = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.seen > SESSION_TTL_MS) sessions.delete(sid);
  }
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------- auth */

// decodeURIComponent throws URIError on malformed escapes such as "%E0%A4%A".
// Cookies come straight off the wire from anyone who can reach the port, so a
// bad cookie must never be able to break the request that carries it.
function safeDecodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookies(req) {
  /** @type {Record<string,string>} */
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = safeDecodeComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenMatches(given) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(TOKEN);
  // Always do a comparison of equal length to keep timing flat.
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// Crude per-IP brute-force brake. Good enough for a single-user box.
const loginFails = new Map(); // ip -> { count, until }
const MAX_FAILS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function isLockedOut(ip) {
  const entry = loginFails.get(ip);
  if (!entry) return false;
  if (entry.until && entry.until > Date.now()) return true;
  if (entry.until && entry.until <= Date.now()) loginFails.delete(ip);
  return false;
}

function recordFail(ip) {
  const entry = loginFails.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILS) entry.until = Date.now() + LOCKOUT_MS;
  loginFails.set(ip, entry);
}

function sessionCookie(sid, maxAgeMs) {
  const bits = [
    `wt_session=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (SECURE_COOKIE) bits.push("Secure");
  return bits.join("; ");
}

/* ------------------------------------------------------------------- http */

const app = express();
app.disable("x-powered-by");

// Network guard runs before everything else, including the login page.
app.use((req, res, next) => {
  const ip = req.socket.remoteAddress;
  if (ipAllowed(ip)) return next();
  log(`[deny] ${normalizeIp(ip)} is outside the allowed ranges`);
  res
    .status(403)
    .type("text")
    .send(
      "Forbidden: this terminal only accepts connections from your local network.\n" +
        "Set ALLOW_PRIVATE_ONLY=0 or ALLOWED_IPS=<cidr,...> to change that.\n",
    );
});

app.use(express.urlencoded({ extended: false, limit: "8kb" }));

// Login page + auth endpoints -------------------------------------------

app.get("/login", (req, res) => {
  if (getSession(parseCookies(req).wt_session)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const ip = normalizeIp(req.socket.remoteAddress) || "unknown";
  if (isLockedOut(ip)) {
    return res.status(429).send("Too many attempts. Try again later.");
  }
  if (!tokenMatches(req.body?.token)) {
    recordFail(ip);
    log(`[auth] failed login from ${ip}`);
    return res.redirect("/login?error=1");
  }
  loginFails.delete(ip);
  const sid = createSession();
  res.setHeader("Set-Cookie", sessionCookie(sid, SESSION_TTL_MS));
  log(`[auth] login ok from ${ip}`);
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  const sid = parseCookies(req).wt_session;
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "wt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.redirect("/login");
});

// Static assets (xterm is public; it contains no secrets) ----------------

const ASSETS = {
  "/assets/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "/assets/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "/assets/addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
};

for (const [route, file] of Object.entries(ASSETS)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

// The terminal page itself requires a session ----------------------------

function requireAuth(req, res, next) {
  if (!getSession(parseCookies(req).wt_session)) return res.redirect("/login");
  next();
}

app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* -------------------------------------------------------------------- ws */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });

let ptyCount = 0;
const ptyCountBySession = new Map(); // sid -> number

// This listener runs outside Express, so an exception thrown here is an
// uncaughtException that terminates the entire process. Anything reachable from
// the network must be wrapped: one malformed request must not kill the gateway.
server.on("upgrade", (req, socket, head) => {
  try {
    handleWsUpgrade(req, socket, head);
  } catch (err) {
    log(`[ws] upgrade failed: ${err?.message || err}`);
    rejectUpgrade(socket, 400, "Bad Request");
  }
});

function rejectUpgrade(socket, code, text) {
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

function handleWsUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") return socket.destroy();

  if (!ipAllowed(req.socket.remoteAddress)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }

  // Same-origin check: blocks cross-site WebSocket hijacking.
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) throw new Error("bad origin");
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
  }

  const sid = parseCookies(req).wt_session;
  if (!getSession(sid)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  const used = ptyCountBySession.get(sid) || 0;
  if (ptyCount >= MAX_PTYS_TOTAL || used >= MAX_PTYS_PER_SESSION) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, sid);
  });
}

wss.on("connection", (ws, req, sid) => {
  const ip = normalizeIp(req.socket.remoteAddress);

  // A failed spawn (missing shell, no ptys left, resource limits) must not
  // propagate out of this event handler — that would kill the server.
  let term;
  try {
    term = pty.spawn(SHELL, ["-l"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: HOME_DIR,
      env: {
        ...process.env,
        HOME: HOME_DIR,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "C.UTF-8",
      },
    });
  } catch (err) {
    log(`[pty] spawn failed from ${ip}: ${err?.message || err}`);
    try {
      ws.close(1011, "failed to start shell");
    } catch {
      /* socket already gone */
    }
    return;
  }

  ptyCount += 1;
  ptyCountBySession.set(sid, (ptyCountBySession.get(sid) || 0) + 1);

  log(`[pty] open pid=${term.pid} from ${ip}`);

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  term.onData((data) => send({ type: "output", data }));
  term.onExit(({ exitCode, signal }) => {
    send({ type: "exit", exitCode, signal });
    // Give the browser a moment to render the exit notice.
    setTimeout(() => ws.close(), 100);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.type === "input" && typeof msg.data === "string") {
      term.write(msg.data);
    } else if (msg?.type === "resize") {
      const cols = Math.max(20, Math.min(500, Number(msg.cols) || 100));
      const rows = Math.max(5, Math.min(200, Number(msg.rows) || 30));
      try {
        term.resize(cols, rows);
      } catch {
        /* pty already gone */
      }
    }
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    ptyCount -= 1;
    const left = (ptyCountBySession.get(sid) || 1) - 1;
    if (left <= 0) ptyCountBySession.delete(sid);
    else ptyCountBySession.set(sid, left);
    try {
      term.kill();
    } catch {
      /* already dead */
    }
    log(`[pty] closed pid=${term.pid}`);
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

// Heartbeat: drop sockets that stopped answering (dead tabs, dropped wifi).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000).unref();

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

/* ---------------------------------------------------------- local console */

// Spawns a shell in the terminal you started the server from and bridges it to
// stdin/stdout. Ctrl+C inside the shell goes to the shell (raw mode), so type
// `exit` to come back to the server, or press Ctrl+C at the prompt to stop it.
let localSession = null;
let consoleStarting = false;

function startLocalConsole() {
  if (consoleStarting || localSession) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log("  --console needs an interactive terminal; running headless instead.");
    return;
  }

  consoleStarting = true;
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;

  const term = pty.spawn(SHELL, ["-l"], {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: HOME_DIR,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      TERM: process.env.TERM || "xterm-256color",
      LANG: process.env.LANG || "C.UTF-8",
    },
  });

  localSession = term;
  log(`[console] local shell pid=${term.pid} -- keystrokes go to this shell; type "exit" to come back`);

  // From here on, logs are buffered so they don't wreck the terminal.
  consoleActive = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();

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
    consoleActive = false;
    localSession = null;
    consoleStarting = false;
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
    flushLogBuffer();
    process.stderr.write(
      "\n  local shell exited. The web server is still running.\n" +
        "  press Enter for a new shell, or Ctrl+C to stop the server.\n",
    );
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      startLocalConsole();
    });
  });

  consoleStarting = false;
}

/* ------------------------------------------------------------------ boot */

function hostUrls(port) {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // docker0, br-xxxx, veth*, virbr0 ... and (inside any container) the
      // container's own eth0 are only reachable inside the container network,
      // so they are useless as "open this on your phone" addresses.
      const containerNet =
        IN_CONTAINER || /^(docker|br-|veth|virbr|podman|cni)/.test(name);
      out.push({ name, url: `http://${a.address}:${port}`, containerNet });
    }
  }
  out.sort((a, b) => Number(a.containerNet) - Number(b.containerNet));
  return out;
}

const urls = hostUrls(PORT);

server.listen(PORT, HOST, () => {
  log("");
  log(`  web terminal listening on http://${HOST}:${PORT}`);
  const wildcard = HOST === "0.0.0.0" || HOST === "::";
  if (urls.length && wildcard) {
    log("  addresses on this machine:");
    for (const u of urls) {
      log(
        `    ${u.url}${u.containerNet ? `   (${u.name}: container network, not your LAN)` : `   (${u.name})`}`,
      );
    }
  }
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    log(
      ALLOW_PRIVATE_ONLY
        ? "  LAN mode: only private-network addresses may connect (ALLOW_PRIVATE_ONLY=1)."
        : "  WARNING: ALLOW_PRIVATE_ONLY=0 -- anyone who can route to this port may connect.",
    );
  }
  log(`  access token: ${TOKEN}${TOKEN_ENV ? "" : "   (generated for this run)"}`);
  log(`  shell: ${SHELL}`);

  if (IN_CONTAINER) {
    log("");
    log(`  running inside a ${IN_CONTAINER} container. Addresses such as 172.17.x / 172.18.x`);
    log("  only exist inside the container network; another device in your house cannot");
    log("  reach them. To open this from a phone or laptop:");
    log('    docker run -p 8080:8080 ...        or compose:  ports: ["8080:8080"]');
    log("    then use the HOST machine's LAN IP (e.g. http://192.168.1.50:8080)");
    log("    or: docker run --network host ...   (container shares the host's network)");
    log("    or: ssh -L 8080:127.0.0.1:8080 user@host");
  }
  if (!CURRENT_USER) {
    log("");
    log(`  warning: uid ${process.getuid?.()} has no /etc/passwd entry.`);
    log("  Shells will show 'I have no name!' and whoami/ps will fail.");
    log("  Fix inside the container, as root:");
    log(
      `    echo "user:x:${process.getuid?.()}:${process.getgid?.()}::/home/user:/bin/bash" >> /etc/passwd`,
    );
    log(`    mkdir -p /home/user && chown ${process.getuid?.()}:${process.getgid?.()} /home/user`);
  }
  log("");

  if (LOCAL_CONSOLE) {
    startLocalConsole();
  } else {
    log("  tip: run with --console to also get a shell in this terminal.");
    log("");
  }
});

// Last resort. Every network-facing throw is caught above, but if a bug slips
// through, a wedged-but-running terminal beats a dead one: log it and keep
// serving instead of exiting. Remove this if you prefer crash-and-restart.
process.on("uncaughtException", (err) => {
  log(`[fatal] uncaught exception: ${err?.stack || err}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushLogBuffer();
    process.stderr.write("\nshutting down\n");
    if (localSession) {
      try {
        localSession.kill();
      } catch {
        /* ignore */
      }
    }
    for (const ws of wss.clients) ws.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
