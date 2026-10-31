import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT || 8080);
// Default is loopback only on purpose. Reach it through an SSH tunnel,
// Tailscale, or a TLS reverse proxy -- never expose this port raw.
const HOST = process.env.HOST || "127.0.0.1";
const SHELL = process.env.SHELL_BIN || process.env.SHELL || "/bin/bash";
const SECURE_COOKIE = process.env.COOKIE_SECURE === "1";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_PTYS_TOTAL = 8;
const MAX_PTYS_PER_SESSION = 4;
const MAX_INPUT_BYTES = 64 * 1024;

let TOKEN = process.env.TERMINAL_TOKEN;
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString("base64url");
  console.log(`\n  Access token (generated): ${TOKEN}`);
  console.log("  Set TERMINAL_TOKEN=<value> to keep it across restarts.\n");
} else if (TOKEN.length < 16) {
  console.error("TERMINAL_TOKEN must be at least 16 characters. Refusing to start.");
  process.exit(1);
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

function parseCookies(req) {
  /** @type {Record<string,string>} */
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
app.use(express.urlencoded({ extended: false, limit: "8kb" }));

// Login page + auth endpoints -------------------------------------------

app.get("/login", (req, res) => {
  if (getSession(parseCookies(req).wt_session)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  if (isLockedOut(ip)) {
    return res.status(429).send("Too many attempts. Try again later.");
  }
  if (!tokenMatches(req.body?.token)) {
    recordFail(ip);
    console.log(`[auth] failed login from ${ip}`);
    return res.redirect("/login?error=1");
  }
  loginFails.delete(ip);
  const sid = createSession();
  res.setHeader("Set-Cookie", sessionCookie(sid, SESSION_TTL_MS));
  console.log(`[auth] login ok from ${ip}`);
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

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") return socket.destroy();

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
});

wss.on("connection", (ws, req, sid) => {
  const ip = req.socket.remoteAddress;
  ptyCount += 1;
  ptyCountBySession.set(sid, (ptyCountBySession.get(sid) || 0) + 1);

  const term = pty.spawn(SHELL, ["-l"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: os.homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "C.UTF-8",
    },
  });

  console.log(`[pty] open pid=${term.pid} from ${ip}`);

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
    console.log(`[pty] closed pid=${term.pid}`);
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

/* ------------------------------------------------------------------ boot */

server.listen(PORT, HOST, () => {
  console.log(`\n  web terminal on http://${HOST}:${PORT}`);
  console.log(`  shell: ${SHELL}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    console.log(
      "  WARNING: listening on a non-loopback address. Put TLS + real auth in front of it.",
    );
  }
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\nshutting down");
    for (const ws of wss.clients) ws.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
