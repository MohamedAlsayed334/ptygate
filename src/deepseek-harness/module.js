import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PREFIX = "/ai";
const UPSTREAM_WS = "/api/remote.mux";

function reject(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  return true;
}

function forwardedHeaders(req) {
  const headers = { ...req.headers, host: "127.0.0.1" };
  if (headers.origin) {
    try {
      const origin = new URL(headers.origin);
      origin.host = "127.0.0.1";
      headers.origin = origin.toString();
    } catch { delete headers.origin; }
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
      const args = [harness.entry, "web", "--no-open", "--host", "127.0.0.1", "--port", String(port), "--trusted-host", "127.0.0.1"];
      const child = spawnProcess(process.execPath, args, { cwd: harness.cwd, env: process.env, stdio: "inherit", shell: false });
      let stopping;
      try {
        await waitReady(child, `${origin}/`);
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
        const target = pathname === "/ai/" ? "/" : pathname.slice(PREFIX.length) || "/";
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
          const lines = [`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: Upgrade", "Upgrade: websocket"];
          for (const [key, value] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (!["host", "connection", "upgrade", "origin", "sec-websocket-accept"].includes(lower) && value !== undefined)
              lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
            if (lower === "origin" && typeof value === "string") {
              try { const origin = new URL(value); origin.host = "127.0.0.1"; lines.push(`Origin: ${origin}`); } catch {}
            }
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
