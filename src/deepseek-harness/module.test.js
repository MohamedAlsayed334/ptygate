import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createDeepSeekHarnessModule, waitReady } from "./module.js";

test("Harness setup prepares the default checkout without opt-in environment flags", async () => {
  let prepared;
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  const routes = new Map();
  let upgrade;
  const upstream = createServer((_req, res) => res.writeHead(204).end());
  let upstreamListening;
  try {
    const cleanup = await createDeepSeekHarnessModule({ prepare: async (dir) => { prepared = dir; return { cwd: dir, entry: "/fake/dsh.js" }; }, spawnProcess: (_cmd, args) => {
      const port = Number(args[args.indexOf("--port") + 1]);
      upstreamListening = new Promise((resolve) => upstream.listen(port, "127.0.0.1", resolve));
      upstreamListening.then(() => { child.kill = (signal) => { child.exitCode = 0; child.signalCode = signal; upstream.close(() => child.emit("exit", null, signal)); }; });
      return child;
    } }).setup({ config: { homeDir: process.cwd(), secureCookie: false }, services: { authManager: { getSession: () => null }, parseCookies: () => ({}) }, http: { route: (_m, r, h) => routes.set(r, h) }, websocket: { onUpgrade: (h) => { upgrade = h; } }, health: { register() {} } });
    await upstreamListening;
    assert.equal(prepared, `${process.cwd()}/.ptygate/deepseek-harness`);
    assert.ok(routes.has("/ai/*path"));
    assert.equal(typeof upgrade, "function");
    await cleanup();
  } finally {
    if (upstream.listening) upstream.close();
  }
});

test("readiness ignores unsuccessful responses until successful status", async (t) => {
  let count = 0;
  const server = createServer((_req, res) => res.writeHead(++count === 1 ? 503 : 204).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const child = { exitCode: null, signalCode: null, on() {}, once() {}, off() {} };
  await waitReady(child, `http://127.0.0.1:${server.address().port}/`, 2000);
  assert.ok(count >= 2);
});

test("readiness rejects immediately when child emits spawn error", async () => {
  const child = new EventEmitter();
  const ready = waitReady(child, "http://127.0.0.1:1/", 10_000);
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(ready, /spawn failed/);
});

test("proxy strips prefix, rewrites redirects/cookies, and gates HTTP and WebSocket by session", async (t) => {
  let proxyRequestSeen = false;
  const upstream = createServer((req, res) => {
    if (req.url === "/") return res.writeHead(204).end();
    proxyRequestSeen = true;
    assert.equal(req.url, "/thing?q=1");
    assert.equal(req.headers.host, "127.0.0.1");
    res.writeHead(302, { location: "/next", "set-cookie": ["sid=x; Path=/; HttpOnly"] }).end("ok");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", null, signal); };
  const routes = new Map();
  let upgradeHandler;
  let sessionValid = true;
  try {
    const cleanup = await createDeepSeekHarnessModule({ prepare: async () => ({ cwd: process.cwd(), entry: "/fake/dsh.js" }), selectPort: async () => upstream.address().port, spawnProcess: () => {
      setTimeout(() => {
        const readiness = request({ host: "127.0.0.1", port: upstream.address().port, path: "/" }, (response) => response.resume());
        readiness.on("error", () => {}); readiness.end();
      }, 0);
      return child;
    } }).setup({
      config: { homeDir: process.cwd(), secureCookie: false },
      services: { authManager: { getSession: () => sessionValid ? ({}) : null }, parseCookies: (req) => req.headers.cookie ? ({ wt_session: "sid" }) : ({}) },
      http: { route: (_method, route, handler) => routes.set(route, handler) },
      websocket: { onUpgrade: (handler) => { upgradeHandler = handler; } },
      health: { register() {} },
    });
    const proxy = routes.get("/ai/*path");
    const result = await new Promise((resolve, reject) => {
      const res = createServer();
      res.on("request", (req, response) => proxy(req, response));
      res.listen(0, "127.0.0.1", () => request({ host: "127.0.0.1", port: res.address().port, path: "/ai/thing?q=1", headers: { host: "public.example" } }, (response) => {
        response.resume(); response.on("end", () => { resolve(response); res.close(); });
      }).on("error", reject).end());
    });
    assert.equal(result.statusCode, 302);
    assert.equal(proxyRequestSeen, true);
    assert.equal(result.headers.location, "/ai/next");
    assert.match(result.headers["set-cookie"][0], /Path=\/ai\//);
    assert.equal(typeof upgradeHandler, "function");
    sessionValid = false;
    const unauthorizedProxyResponse = await new Promise((resolve, reject) => {
      const proxyServer = createServer((req, res) => proxy(req, res));
      proxyServer.listen(0, "127.0.0.1", () => request({ host: "127.0.0.1", port: proxyServer.address().port, path: "/ai/" }, (response) => {
        response.resume(); response.on("end", () => { resolve(response); proxyServer.close(); });
      }).on("error", reject).end());
    });
    assert.equal(unauthorizedProxyResponse.statusCode, 302);
    assert.match(unauthorizedProxyResponse.headers.location, /^\/login\?returnTo=/);
    const denied = new PassThrough();
    const upgradeReq = { url: "/ai/api/remote.mux", headers: { host: "example.test" } };
    assert.equal(upgradeHandler(upgradeReq, denied, Buffer.alloc(0)), true);
    assert.match(denied.read().toString(), /401 Unauthorized/);
    await cleanup();
  } finally { await new Promise((resolve) => upstream.close(resolve)); }
});
