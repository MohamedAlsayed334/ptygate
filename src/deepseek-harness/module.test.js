import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { createDeepSeekHarnessModule, waitReady } from "./module.js";

test("DeepSeek Harness stays disabled unless explicitly enabled", async () => {
  const previous = process.env.DEEPSEEK_HARNESS_ENABLED;
  delete process.env.DEEPSEEK_HARNESS_ENABLED;
  try { assert.equal(await createDeepSeekHarnessModule().setup({}), undefined); }
  finally { if (previous === undefined) delete process.env.DEEPSEEK_HARNESS_ENABLED; else process.env.DEEPSEEK_HARNESS_ENABLED = previous; }
});

test("enabled Harness requires checkout and public trusted host configuration", async () => {
  const previous = process.env.DEEPSEEK_HARNESS_ENABLED;
  process.env.DEEPSEEK_HARNESS_ENABLED = "1";
  try { await assert.rejects(createDeepSeekHarnessModule().setup({}), /DEEPSEEK_HARNESS_DIR/); }
  finally { if (previous === undefined) delete process.env.DEEPSEEK_HARNESS_ENABLED; else process.env.DEEPSEEK_HARNESS_ENABLED = previous; }
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

test("proxy strips prefix and rewrites redirects and cookie paths", async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((req, res) => {
    if (++upstreamRequests === 1 && req.url === "/") return res.writeHead(204).end();
    assert.equal(req.url, "/thing?q=1");
    assert.equal(req.headers.host, "public.example");
    res.writeHead(302, { location: "/next", "set-cookie": ["sid=x; Path=/; HttpOnly"] }).end("ok");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; child.emit("exit", null, signal); };
  const previous = { ...process.env };
  process.env.DEEPSEEK_HARNESS_ENABLED = "1";
  process.env.DEEPSEEK_HARNESS_DIR = process.cwd();
  process.env.DEEPSEEK_HARNESS_PUBLIC_HOST = "public.example";
  process.env.DEEPSEEK_HARNESS_PORT = String(upstream.address().port);
  process.env.DEEPSEEK_HARNESS_HTTPS = "0";
  const routes = new Map();
  let upgradeHandler;
  try {
    const cleanup = await createDeepSeekHarnessModule({ spawnProcess: () => child }).setup({
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
    assert.equal(result.headers.location, "/ai/next");
    assert.match(result.headers["set-cookie"][0], /Path=\/ai\//);
    assert.equal(typeof upgradeHandler, "function");
    await cleanup();
  } finally {
    for (const key of ["DEEPSEEK_HARNESS_ENABLED", "DEEPSEEK_HARNESS_DIR", "DEEPSEEK_HARNESS_PUBLIC_HOST", "DEEPSEEK_HARNESS_PORT", "DEEPSEEK_HARNESS_HTTPS"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
