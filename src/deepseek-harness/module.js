import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";

const PREFIX = "/ai";
const UPSTREAM_WS = "/api/remote.mux";

function reject(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  return true;
}

function forwardedHeaders(req) {
  return { ...req.headers, host: req.headers.host };
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

export function createDeepSeekHarnessModule({ spawnProcess = spawn } = {}) {
  return {
    id: "deepseek-harness",
    prefix: PREFIX,
    async setup({ http: routes, websocket, health }) {
      if (process.env.DEEPSEEK_HARNESS_ENABLED !== "1") return;
      const checkout = process.env.DEEPSEEK_HARNESS_DIR;
      const publicHost = process.env.DEEPSEEK_HARNESS_PUBLIC_HOST;
      if (!checkout || !publicHost || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::\d+)?$/i.test(publicHost)) {
        throw new Error("DeepSeek Harness requires DEEPSEEK_HARNESS_DIR and a valid DEEPSEEK_HARNESS_PUBLIC_HOST");
      }
      const rawPort = process.env.DEEPSEEK_HARNESS_PORT;
      const port = rawPort ? Number(rawPort) : await freeLoopbackPort();
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("DEEPSEEK_HARNESS_PORT must be a valid unprivileged port");
      const secure = process.env.DEEPSEEK_HARNESS_HTTPS !== "0";
      const transport = http;
      const origin = `http://127.0.0.1:${port}`;
      const command = process.env.DEEPSEEK_HARNESS_COMMAND || "pnpm";
      const args = ["dsh", "web", "--no-open", "--host", "127.0.0.1", "--port", String(port), "--public-url", `${secure ? "https" : "http"}://${publicHost}/ai/`, "--trusted-host", publicHost];
      const child = spawnProcess(command, args, { cwd: checkout, env: process.env, stdio: "inherit", shell: false });
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

      const proxy = (req, res) => {
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
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) routes.route(method, `/ai/*path`, proxy);
      websocket.onUpgrade((req, socket, head) => {
        let url;
        try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return reject(socket, 400, "Bad Request"); }
        if (url.pathname !== `${PREFIX}${UPSTREAM_WS}`) return false;
        const upstream = net.connect(port, "127.0.0.1", () => {
          const path = `${url.pathname.slice(PREFIX.length)}${url.search}`;
          const lines = [`GET ${path} HTTP/1.1`, `Host: ${req.headers.host}`, "Connection: Upgrade", "Upgrade: websocket"];
          for (const [key, value] of Object.entries(req.headers)) if (!["host", "connection", "upgrade"].includes(key.toLowerCase()) && value !== undefined) lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
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
