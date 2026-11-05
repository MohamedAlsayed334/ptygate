import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { parseCookies, formatSessionCookie } from "../auth.js";

export function createTerminalModule() {
  return {
    id: "terminal",
    prefix: "/",
    setup({ http, websocket, config, services, rootDir }) {
      const { authManager, ptyManager } = services;
      let previousCpu = null;
      const readMetric = async (file) => {
        try {
          return (await fs.readFile(file, "utf8")).trim();
        } catch {
          return null;
        }
      };
      const cgroupCpuPath = "/sys/fs/cgroup/cpu.stat";
      const getMetrics = async () => {
        const [memoryCurrent, memoryMax, cpuStat, cpuMax, disk] = await Promise.all([
          readMetric("/sys/fs/cgroup/memory.current"),
          readMetric("/sys/fs/cgroup/memory.max"),
          readMetric(cgroupCpuPath),
          readMetric("/sys/fs/cgroup/cpu.max"),
          fs.statfs(config.homeDir).catch(() => null),
        ]);
        const memoryTotal = memoryMax && memoryMax !== "max" ? Number(memoryMax) : os.totalmem();
        const memoryUsed = memoryCurrent !== null ? Number(memoryCurrent) : memoryTotal - os.freemem();
        let cpuPercent = 0;
        const usageLine = cpuStat?.split("\n").find((line) => line.startsWith("usage_usec "));
        const usage = usageLine ? Number(usageLine.split(/\s+/)[1]) : null;
        const now = performance.now();
        if (usage !== null && Number.isFinite(usage)) {
          if (previousCpu && usage >= previousCpu.usage) {
            const elapsedUsec = (now - previousCpu.time) * 1000;
            let cores = 1;
            const [quota, period] = cpuMax?.split(/\s+/).map(Number) ?? [];
            if (quota > 0 && period > 0) cores = quota / period;
            cpuPercent = Math.min(100, ((usage - previousCpu.usage) / elapsedUsec / cores) * 100);
          }
          previousCpu = { usage, time: now };
        }
        const diskTotal = disk ? Number(disk.blocks) * Number(disk.bsize) : null;
        const diskFree = disk ? Number(disk.bavail) * Number(disk.bsize) : null;
        return {
          cpuPercent,
          memory: { used: memoryUsed, total: memoryTotal },
          disk: diskTotal === null ? null : { used: diskTotal - diskFree, total: diskTotal },
        };
      };
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
      http.route("GET", "/api/terminal/metrics", async (req, res) => {
        if (!authManager.getSession(parseCookies(req).wt_session)) {
          return res.status(401).json({ error: "unauthorized" });
        }
        res.setHeader("Cache-Control", "no-store");
        res.json(await getMetrics());
      });
      websocket.route("/ws", services.terminalWebSocket);
    },
  };
}
