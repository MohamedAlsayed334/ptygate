import path from "node:path";
import express from "express";
import { isIpAllowed, normalizeIp } from "./ip_policy.js";
import { parseCookies, formatSessionCookie } from "./auth.js";
import { logger } from "./logger.js";
import { NAME, VERSION, PROTOCOL } from "./version.js";

/**
 * Configure Express HTTP application.
 * @param {object} config
 * @param {import("./auth.js").AuthManager} authManager
 * @param {import("./pty.js").PtyManager} ptyManager
 * @param {string} rootDir
 */
export function createHttpApp(config, authManager, ptyManager, rootDir) {
  const app = express();
  app.disable("x-powered-by");

  // Global IP policy guard: runs before everything, including static assets and healthz
  app.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (isIpAllowed(ip, config)) return next();

    logger.log(`[deny] ${normalizeIp(ip)} is outside the allowed ranges`);
    res
      .status(403)
      .type("text/plain")
      .send(
        "Forbidden: this terminal only accepts connections from your local network.\n" +
          "Set ALLOW_PRIVATE_ONLY=0 or ALLOWED_IPS=<cidr,...> to change that.\n",
      );
  });

  // Body parser with strict limits
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));

  // GET /healthz - unauthenticated liveness check
  app.get("/healthz", (req, res) => {
    res.type("text/plain").send("ok");
  });

  // GET /version - protocol v1 version & capabilities metadata
  app.get("/version", (req, res) => {
    res.json({
      name: NAME,
      impl: "node",
      version: VERSION,
      protocol: PROTOCOL,
      // Contract v1 requires all three booleans; this implementation only speaks plain HTTP.
      transports: {
        http: true,
        tls: false,
        ssh: false,
      },
      ip_mode: config.ipMode,
    });
  });

  // GET /login - display login form
  app.get("/login", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const cookies = parseCookies(req);
    if (authManager.getSession(cookies.wt_session)) {
      return res.redirect(302, "/");
    }
    res.sendFile(path.join(rootDir, "public", "login.html"));
  });

  // POST /login - authenticate token
  app.post("/login", (req, res) => {
    const ip = normalizeIp(req.socket.remoteAddress) || "unknown";

    if (authManager.isLockedOut(ip)) {
      return res.status(429).type("text/plain").send("Too many attempts. Try again later.");
    }

    const tokenInput = req.body?.token;
    if (tokenInput === undefined || tokenInput === null || typeof tokenInput !== "string" || !authManager.verifyToken(tokenInput)) {
      authManager.recordFail(ip);
      logger.log(`[auth] failed login from ${ip}`);
      // Return 401 Unauthorized per protocol specification
      return res.status(401).type("text/plain").send("Unauthorized: Invalid token.\n");
    }

    authManager.recordSuccess(ip);
    const sid = authManager.createSession();
    const cookie = formatSessionCookie(sid, config.sessionTtlMs, config.secureCookie);
    res.setHeader("Set-Cookie", cookie);
    logger.log(`[auth] login ok from ${ip}`);
    // 303 See Other per specification
    res.redirect(303, "/");
  });

  // GET /logout and POST /logout - clear session and kill detached PTY
  const handleLogout = (req, res) => {
    const cookies = parseCookies(req);
    const sid = cookies.wt_session;
    if (sid) {
      authManager.deleteSession(sid);
      ptyManager.destroySessionPty(sid);
    }
    const clearCookie = "wt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" +
      (config.secureCookie ? "; Secure" : "");
    res.setHeader("Set-Cookie", clearCookie);
    res.redirect(303, "/login");
  };

  app.get("/logout", handleLogout);
  app.post("/logout", handleLogout);

  // Static Assets (/assets/*)
  const ASSETS = {
    "/assets/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
    "/assets/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
    "/assets/addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
  };

  for (const [route, relPath] of Object.entries(ASSETS)) {
    app.get(route, (req, res) => {
      res.sendFile(path.join(rootDir, relPath));
    });
  }

  // Auth guard middleware for protected web UI
  function requireAuth(req, res, next) {
    const cookies = parseCookies(req);
    if (!authManager.getSession(cookies.wt_session)) {
      return res.redirect(302, "/login");
    }
    next();
  }

  // GET / - terminal UI
  app.get("/", requireAuth, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(rootDir, "public", "index.html"));
  });

  // 404 for unknown routes
  app.use((req, res) => {
    res.status(404).type("text/plain").send("Not Found");
  });

  return app;
}
