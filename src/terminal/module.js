import path from "node:path";
import { parseCookies, formatSessionCookie } from "../auth.js";

export function createTerminalModule() {
  return {
    id: "terminal",
    prefix: "/",
    setup({ http, websocket, config, services, rootDir }) {
      const { authManager, ptyManager } = services;
      http.route("GET", "/login", (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        if (authManager.getSession(parseCookies(req).wt_session))
          return res.redirect(302, "/");
        res.sendFile(path.join(rootDir, "public", "login.html"));
      });
      http.route("POST", "/login", (req, res) => {
        const ip = services.normalizeIp(req.socket.remoteAddress) || "unknown";
        if (authManager.isLockedOut(ip))
          return res
            .status(429)
            .type("text/plain")
            .send("Too many attempts. Try again later.");
        const tokenInput = req.body?.token;
        if (
          typeof tokenInput !== "string" ||
          !authManager.verifyToken(tokenInput)
        ) {
          authManager.recordFail(ip);
          return res
            .status(401)
            .type("text/plain")
            .send("Unauthorized: Invalid token.\n");
        }
        authManager.recordSuccess(ip);
        res.setHeader(
          "Set-Cookie",
          formatSessionCookie(
            authManager.createSession(),
            config.sessionTtlMs,
            config.secureCookie,
          ),
        );
        res.redirect(303, "/");
      });
      const logout = (req, res) => {
        const sid = parseCookies(req).wt_session;
        if (sid) {
          authManager.deleteSession(sid);
          ptyManager.destroySessionPty(sid);
        }
        res.setHeader(
          "Set-Cookie",
          `wt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookie ? "; Secure" : ""}`,
        );
        res.redirect(303, "/login");
      };
      http.route("GET", "/logout", logout);
      http.route("POST", "/logout", logout);
      for (const [route, file] of Object.entries({
        "/assets/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
        "/assets/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
        "/assets/addon-fit.js":
          "node_modules/@xterm/addon-fit/lib/addon-fit.js",
      })) {
        http.route("GET", route, (_req, res) =>
          res.sendFile(path.join(rootDir, file)),
        );
      }
      http.route("GET", "/", (req, res) => {
        if (!authManager.getSession(parseCookies(req).wt_session))
          return res.redirect(302, "/login");
        res.setHeader("Cache-Control", "no-store");
        res.sendFile(path.join(rootDir, "public", "index.html"));
      });
      websocket.route("/ws", services.terminalWebSocket);
    },
  };
}
