import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

const PREFIX = "/ai";
const UPSTREAM_WS = "/api/remote.mux";

function reject(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  return true;
}

function forwardedHeaders(req) {
  // Harness validates Host and Origin against its trusted public authorities.
  // The TCP connection remains loopback-only; preserve browser-facing headers,
  // but do not disclose ptygate's own session cookie to the child application.
  const headers = { ...req.headers };
  if (headers.cookie) {
    const cookies = headers.cookie.split(";").map((part) => part.trim()).filter((part) => part && !/^wt_session=/i.test(part));
    if (cookies.length) headers.cookie = cookies.join("; ");
    else delete headers.cookie;
  }
  return headers;
}

function rewriteResponseHeaders(headers, secure) {
  const out = { ...headers };
  if (out.location) out.location = out.location.replace(/^\/(?!ai\/)/, "/ai/");
  const cookies = out["set-cookie"];
  if (cookies) out["set-cookie"] = (Array.isArray(cookies) ? cookies : [cookies]).map((cookie) => {
    let result = cookie.replace(/;\s*Path=\//i, "; Path=/ai/");
    if (secure && !/(?:^|;)\s*Secure(?:;|$)/i.test(result)) result += "; Secure";
    return result;
  });
  return out;
}

async function freeLoopbackPort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

export function waitReady(child, url, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true; clearInterval(timer); clearTimeout(timeout); child.off("exit", exited); child.off("error", onError);
      error ? reject(error) : resolve();
    };
    const exited = (code, signal) => finish(new Error(`DeepSeek Harness exited during startup (code ${code}, signal ${signal})`));
    const onError = (error) => finish(error);
    child.once("exit", exited);
    child.once("error", onError);
    const timer = setInterval(() => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 400) finish();
      });
      request.setTimeout(1500, () => request.destroy());
      request.on("error", () => {});
    }, 500);
    const timeout = setTimeout(() => finish(new Error("DeepSeek Harness did not become ready within 90 seconds")), timeoutMs);
  });
}

export function waitPortReady(child, port, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(timeout);
      child.off("exit", exited);
      child.off("error", onError);
      error ? reject(error) : resolve();
    };
    const exited = (code, signal) => finish(new Error(`DeepSeek Harness exited during startup (code ${code}, signal ${signal})`));
    const onError = (error) => finish(error);
    child.once("exit", exited);
    child.once("error", onError);
    const timer = setInterval(() => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.destroy();
        finish();
      });
      socket.setTimeout(1000, () => socket.destroy());
      socket.on("error", () => {});
    }, 250);
    const timeout = setTimeout(() => finish(new Error("DeepSeek Harness did not become ready within 90 seconds")), timeoutMs);
  });
}

function captureLaunchUrl(child, expectedPort) {
  let output = "";
  let launchUrl = null;
  const pending = new Map();
  const inspect = (chunk) => {
    const text = chunk.toString();
    output = (output + text).slice(-16_384);
    const match = output.match(/dsh web:\s*(https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/i);
    if (match) {
      try {
        const parsed = new URL(match[1]);
        if (Number(parsed.port) === expectedPort && parsed.searchParams.has("token")) launchUrl = parsed;
      } catch {}
    }
  };
  const forward = (stream) => {
    if (!stream) return;
    pending.set(stream, "");
    stream.on("data", (chunk) => {
      inspect(chunk);
      let text = pending.get(stream) + chunk.toString();
      const lines = text.split(/(?<=\n)/);
      text = lines.pop() || "";
      // Keep an incomplete URL/token line buffered so chunk boundaries cannot
      // bypass redaction. Bound other unterminated output to avoid growth.
      if (text.length > 16_384 && !/dsh web:\s*https?:\/\/127\.0\.0\.1:\d+\/\?token=/i.test(text)) {
        process.stderr.write(text.slice(0, -1024));
        text = text.slice(-1024);
      }
      pending.set(stream, text);
      for (const line of lines) {
        process.stderr.write(line.replace(/(dsh web:\s*https?:\/\/127\.0\.0\.1:\d+\/\?token=)[^\s]+/ig, "$1[redacted]"));
      }
    });
    stream.on("end", () => {
      const text = pending.get(stream) || "";
      process.stderr.write(text.replace(/(dsh web:\s*https?:\/\/127\.0\.0\.1:\d+\/\?token=)[^\s]+/ig, "$1[redacted]"));
      pending.delete(stream);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  return () => launchUrl;
}

async function preparePackage(installDir, spawnProcess) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 9)) {
    throw new Error(`DeepSeek Harness requires Node.js >=24.9.0; this container runs ${process.versions.node}. Select a Node 24.9+ hosting image, then restart.`);
  }
  await fs.mkdir(installDir, { recursive: true });
  const env = { ...process.env, PATH: [process.env.PATH, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter) };
  const run = (command, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: "inherit", shell: false, env, ...options });
    child.once("error", (error) => {
      if (error.code === "ENOENT") reject(new Error(`Could not find '${command}' in the server PATH (${env.PATH}). Check the hosting panel's startup environment.`));
      else reject(error);
    });
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} failed with exit code ${code}`)));
  });
  const packageJson = path.join(installDir, "package.json");
  let installedVersion = null;
  try { installedVersion = JSON.parse(await fs.readFile(packageJson, "utf8")).dependencies?.["@deepseek-ai/dsh"]; } catch {}
  if (installedVersion !== "0.2.2-rc.1") {
    await fs.writeFile(packageJson, JSON.stringify({ private: true, type: "module", dependencies: { "@deepseek-ai/dsh": "0.2.2-rc.1" } }, null, 2));
    await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: installDir });
  }
  const entry = path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  await fs.access(entry);
  return { cwd: installDir, entry };
}

export function createDeepSeekHarnessModule({
  spawnProcess = spawn,
  prepare = (installDir) => preparePackage(installDir, spawnProcess),
  selectPort = freeLoopbackPort,
} = {}) {
  return {
    id: "deepseek-harness",
    prefix: PREFIX,
    async setup({ http: routes, websocket, health, config, services }) {
      const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
      if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9)) {
        throw new Error(`DeepSeek Harness requires Node.js >=24.9.0; this container runs ${process.versions.node}. Select a Node 24.9+ hosting image, then restart.`);
      }
      const { authManager } = services;
      const parseCookies = services.parseCookies;
      const installDir = path.join(config.homeDir, ".ptygate", "deepseek-harness");
      await fs.mkdir(config.homeDir, { recursive: true });
      const harness = await prepare(installDir);
      const port = await selectPort();
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("DEEPSEEK_HARNESS_PORT must be a valid unprivileged port");
      const secure = config.secureCookie;
      const transport = http;
      const origin = `http://127.0.0.1:${port}`;
      const trustedHosts = (process.env.DEEPSEEK_HARNESS_TRUSTED_HOSTS || "")
        .split(",").map((host) => host.trim()).filter(Boolean);
      const args = [harness.entry, "web", "--no-open", "--host", "127.0.0.1", "--port", String(port), "--trusted-host", "127.0.0.1"];
      for (const host of trustedHosts) args.push("--trusted-host", host);
      const child = spawnProcess(process.execPath, args, { cwd: harness.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
      const getLaunchUrl = captureLaunchUrl(child, port);
      let startupError;
      child.once("error", (error) => { startupError = error; });
      child.stdout?.resume();
      child.stderr?.resume();
      let stopping;
      try {
        const deadline = Date.now() + 90_000;
        let launchUrl;
        while (!(launchUrl = getLaunchUrl()) && Date.now() < deadline) {
          if (startupError) throw startupError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`DeepSeek Harness exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!launchUrl) throw new Error("DeepSeek Harness did not print its launch URL within 90 seconds");
        await waitPortReady(child, port, Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit").catch(() => {});
          const grace = new Promise((resolve) => setTimeout(resolve, 3000));
          child.kill("SIGTERM");
          await Promise.race([exited, grace]);
          if (child.exitCode === null && child.signalCode === null) {
            const killed = once(child, "exit").catch(() => {});
            child.kill("SIGKILL");
            await killed;
          }
        }
        throw error;
      }

      const authenticated = (req, res) => {
        const sid = parseCookies(req).wt_session;
        if (authManager.getSession(sid)) return true;
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(302, { Location: `/login?returnTo=${encodeURIComponent(req.originalUrl || req.url || "/ai/")}` });
        res.end();
        return false;
      };
      const proxy = (req, res) => {
        if (!authenticated(req, res)) return;
        if (req.url === "/ai") { res.writeHead(308, { location: "/ai/" }).end(); return; }
        const pathname = req.url || "/";
        let target = pathname === "/ai/" ? "/" : pathname.slice(PREFIX.length) || "/";
        const hasHarnessSession = Object.keys(parseCookies(req)).some((name) => name.startsWith("dsh-auth-"));
        if (pathname === "/ai/" && !hasHarnessSession && !new URLSearchParams(target.split("?")[1] || "").has("token")) {
          const launchUrl = getLaunchUrl();
          if (!launchUrl) { res.writeHead(503).end("DeepSeek Harness launch URL unavailable"); return; }
          target = `/${launchUrl.search}`;
        }
        const client = transport.request(`${origin}${target}`, { method: req.method, headers: forwardedHeaders(req) }, (upstream) => {
          res.writeHead(upstream.statusCode || 502, rewriteResponseHeaders(upstream.headers, secure));
          upstream.pipe(res);
        });
        client.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("DeepSeek Harness unavailable"); });
        req.pipe(client);
      };
      routes.route("GET", "/ai", proxy); routes.route("GET", "/ai/*path", proxy);
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) routes.route(method, "/ai", proxy);
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) routes.route(method, `/ai/*path`, proxy);
      websocket.onUpgrade((req, socket, head) => {
        let url;
        try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return reject(socket, 400, "Bad Request"); }
        if (url.pathname !== `${PREFIX}${UPSTREAM_WS}`) return false;
        const sid = parseCookies(req).wt_session;
        if (!authManager.getSession(sid)) return reject(socket, 401, "Unauthorized");
        const upstream = net.connect(port, "127.0.0.1", () => {
          const path = `${url.pathname.slice(PREFIX.length)}${url.search}`;
          const lines = [`GET ${path} HTTP/1.1`, `Host: ${req.headers.host || "127.0.0.1"}`, "Connection: Upgrade", "Upgrade: websocket"];
          if (req.headers.origin) lines.push(`Origin: ${req.headers.origin}`);
          for (const [key, value] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (lower === "cookie" && typeof value === "string") {
              const cookies = value.split(";").map((part) => part.trim()).filter((part) => part && !/^wt_session=/i.test(part));
              if (cookies.length) lines.push(`Cookie: ${cookies.join("; ")}`);
              continue;
            }
            if (!["host", "connection", "upgrade", "origin", "sec-websocket-accept"].includes(lower) && value !== undefined)
              lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
          }
          upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => reject(socket, 502, "Bad Gateway"));
        socket.on("error", () => upstream.destroy());
        return true;
      });
      health.register(async () => ({ healthy: child.exitCode === null && child.signalCode === null }));
      return async () => {
        if (stopping) return stopping;
        stopping = (async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, "exit").catch(() => {});
          const grace = new Promise((resolve) => setTimeout(resolve, 5000));
          child.kill("SIGTERM");
          await Promise.race([exited, grace]);
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit").catch(() => {});
            child.kill("SIGKILL");
            await exited;
          }
        })();
        return stopping;
      };
    },
  };
}
