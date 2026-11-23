import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PREFIX,
  computeCliToken,
  createNinerouterModule,
  ensureIdentity,
  prepareChildEnv,
  prepareInstall,
  rewriteBody,
  rewriteHeaders,
  waitReady,
} from "./module.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.exitCode = 0;
    child.signalCode = signal;
    child.emit("exit", 0, signal);
  };
  return child;
}

function proxyRequest(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ response, body: Buffer.concat(chunks).toString("utf8") }));
    });
    client.on("error", reject);
    client.end();
  });
}

test("computeCliToken follows 9router's machine-id/cli-secret derivation", () => {
  const token = computeCliToken("machine", "secret");
  assert.equal(token.length, 16);
  assert.match(token, /^[a-f0-9]{16}$/);
  assert.equal(token, computeCliToken("machine", "secret"));
  assert.notEqual(token, computeCliToken("other", "secret"));
});

test("ensureIdentity persists stable files and a private secrets sidecar", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ninerouter-identity-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const installDir = path.join(homeDir, ".ptygate", "ninerouter");

  const first = await ensureIdentity(installDir, { NINEROUTER_MACHINE_ID: "fixed-machine" });
  const second = await ensureIdentity(installDir, { NINEROUTER_MACHINE_ID: "fixed-machine" });
  assert.equal(first.rawMachineId, "fixed-machine");
  assert.equal(second.cliSecret, first.cliSecret);
  assert.equal(second.cliToken, first.cliToken);
  assert.equal(second.dashboardPassword, first.dashboardPassword);
  assert.match(await fs.readFile(path.join(first.dataDir, "machine-id"), "utf8"), /fixed-machine/);
  assert.match(await fs.readFile(path.join(first.dataDir, "auth", "cli-secret"), "utf8"), /^[a-f0-9]{64}$/m);
  const secrets = JSON.parse(await fs.readFile(path.join(installDir, "secrets.json"), "utf8"));
  assert.equal(secrets.machineId, "fixed-machine");
  assert.ok(secrets.dashboardPassword);
});

test("proxy helpers rewrite prefix paths, locations, cookies and HTML assets", () => {
  const headers = rewriteHeaders({
    location: "/dashboard",
    "set-cookie": ["auth_token=abc; Path=/; HttpOnly"],
    "transfer-encoding": "chunked",
  }, PREFIX, true);
  assert.equal(headers.location, `${PREFIX}/dashboard`);
  assert.match(headers["set-cookie"][0], new RegExp(`Path=${PREFIX}/`));
  assert.match(headers["set-cookie"][0], /Secure/);
  assert.equal(headers["transfer-encoding"], undefined);

  assert.equal(rewriteHeaders({ location: `${PREFIX}/dashboard` }, PREFIX).location, `${PREFIX}/dashboard`);
  const html = rewriteBody(
    '<script>fetch("/api/health");</script><link href="/_next/static/app.css">',
    PREFIX,
  );
  assert.match(html, /fetch\("\/9router\/api\/health"\)/);
  assert.match(html, /href="\/9router\/_next\/static\/app\.css"/);
  assert.doesNotMatch(html, /\/9router\/9router/);
});

test("prepareInstall reuses a matching installation without running npm", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ninerouter-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installDir = path.join(root, "install");
  const serverPath = path.join(installDir, "node_modules", "9router", "app", "custom-server.js");
  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  await fs.writeFile(serverPath, "// installed\n");
  await fs.writeFile(
    path.join(installDir, "install.json"),
    JSON.stringify({ version: "0.5.119", arch: process.arch }),
  );

  let spawned = 0;
  const result = await prepareInstall(installDir, {
    env: { NINEROUTER_SKIP_UPDATE: "1" },
    spawnProcess: () => { spawned += 1; throw new Error("npm should not run"); },
    log() {},
  });
  assert.equal(result.serverPath, serverPath);
  assert.equal(result.version, "0.5.119");
  assert.equal(spawned, 0);
});

test("prepareInstall resolves npm latest to a concrete version before installing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ninerouter-latest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installDir = path.join(root, "install");
  const serverPath = path.join(installDir, "node_modules", "9router", "app", "custom-server.js");
  let installArgs;
  let fetched = 0;

  const result = await prepareInstall(installDir, {
    env: {},
    fetchImpl: async (url) => {
      fetched += 1;
      assert.match(url, /registry\.npmjs\.org\/9router\/latest$/);
      return { ok: true, json: async () => ({ version: "9.9.9" }) };
    },
    spawnProcess: (_command, args) => {
      installArgs = args;
      const child = new EventEmitter();
      setImmediate(async () => {
        await fs.mkdir(path.dirname(serverPath), { recursive: true });
        await fs.writeFile(serverPath, "// installed\n");
        child.emit("exit", 0);
      });
      return child;
    },
    log() {},
  });

  assert.equal(fetched, 1);
  assert.ok(installArgs.includes("9router@9.9.9"));
  assert.equal(result.version, "9.9.9");
  assert.match(
    await fs.readFile(path.join(installDir, "install.json"), "utf8"),
    /"version": "9\.9\.9"/,
  );
});

test("prepareChildEnv restores sql.js wasm and extends NODE_PATH without leaking DATA_DIR", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ninerouter-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverPath = path.join(root, "node_modules", "9router", "app", "custom-server.js");
  const hookPath = path.join(root, "node_modules", "9router", "hooks", "sqliteRuntime.js");
  const dataDir = path.join(root, "data");
  const runtimeWasm = path.join(dataDir, "runtime", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const bundledWasm = path.join(root, "node_modules", "9router", "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, `const path = require("node:path");
module.exports = {
  ensureSqliteRuntime() {},
  buildEnvWithRuntime(base) {
    const runtime = path.join(base.DATA_DIR, "runtime", "node_modules");
    return { ...base, NODE_PATH: [runtime, base.NODE_PATH].filter(Boolean).join(path.delimiter) };
  },
};
`);
  await fs.mkdir(path.dirname(runtimeWasm), { recursive: true });
  await fs.writeFile(runtimeWasm, "wasm");

  const originalDataDir = process.env.DATA_DIR;
  const env = { NODE_PATH: "/existing" };
  const result = await prepareChildEnv({ serverPath, dataDir, env, log() {} });
  assert.equal(process.env.DATA_DIR, originalDataDir);
  assert.equal(result.DATA_DIR, dataDir);
  assert.equal(
    result.NODE_PATH,
    [path.join(dataDir, "runtime", "node_modules"), "/existing"].join(path.delimiter),
  );
  assert.equal(await fs.readFile(bundledWasm, "utf8"), "wasm");

  const missingHook = await prepareChildEnv({
    serverPath: path.join(root, "missing", "app", "custom-server.js"),
    dataDir,
    env,
    log() {},
  });
  assert.equal(missingHook.NODE_PATH, "/existing");
});

test("module installs routes, creates an API key, proxies and forwards upgrades", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ninerouter-module-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));

  let seenRequest;
  let seenUpgrade;
  let seenSpawnArgs;
  let seenSpawnEnv;
  let listedKeys = false;
  let createdKey = false;
  const upstream = createServer((req, res) => {
    seenRequest = { url: req.url, headers: req.headers };
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.url === "/api/keys" && req.method === "GET") {
      listedKeys = true;
      res.writeHead(200, { "content-type": "application/json" }).end('{"keys":[]}');
      return;
    }
    if (req.url === "/api/keys" && req.method === "POST") {
      createdKey = true;
      res.writeHead(201, { "content-type": "application/json" })
        .end('{"key":"sk-test-key","name":"ptygate"}');
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      return;
    }
    if (req.url.startsWith("/dashboard")) {
      res.writeHead(200, { "content-type": "text/html" })
        .end('<html><head><script src="/_next/static/app.js"></script></head></html>');
      return;
    }
    res.writeHead(302, {
      location: "/dashboard",
      "set-cookie": ["auth_token=secret; Path=/; HttpOnly"],
    }).end("redirect");
  });
  upstream.on("upgrade", (req, socket) => {
    seenUpgrade = { url: req.url, headers: req.headers };
    socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = upstream.address().port;
  t.after(() => upstream.close());

  const child = fakeChild();
  const routes = new Map();
  let upgradeHandler;
  let healthHandler;
  let preparedDir;
  let cleanup;
  const logs = [];
  const originalDataDir = process.env.DATA_DIR;
  const installDir = path.join(homeDir, ".ptygate", "ninerouter");
  const hookPath = path.join(installDir, "node_modules", "9router", "hooks", "sqliteRuntime.js");
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, `const path = require("node:path");
module.exports = {
  ensureSqliteRuntime() {},
  buildEnvWithRuntime(base) {
    const runtime = path.join(base.DATA_DIR, "runtime", "node_modules");
    return { ...base, NODE_PATH: [runtime, base.NODE_PATH].filter(Boolean).join(path.delimiter) };
  },
};
`);
  try {
    cleanup = await createNinerouterModule({
      prepare: async (dir) => {
        preparedDir = dir;
        return {
          cwd: dir,
          serverPath: path.join(dir, "node_modules", "9router", "app", "custom-server.js"),
          version: "0.5.119",
        };
      },
      selectPortNumber: async () => port,
      spawnProcess: (binary, args, options) => {
        seenSpawnArgs = args;
        seenSpawnEnv = options.env;
        assert.equal(binary, process.execPath);
        return child;
      },
      log: (line) => logs.push(line),
      env: {},
    }).setup({
      config: { homeDir, port: 24723, secureCookie: false },
      http: { route: (method, route, handler) => routes.set(`${method} ${route}`, handler) },
      websocket: { onUpgrade: (handler) => { upgradeHandler = handler; } },
      health: { register: (handler) => { healthHandler = handler; } },
    });

    assert.equal(preparedDir, path.join(homeDir, ".ptygate", "ninerouter"));
    assert.match(seenSpawnArgs[1], /custom-server\.js$/);
    assert.equal(seenSpawnEnv.PORT, String(port));
    assert.equal(seenSpawnEnv.HOSTNAME, "127.0.0.1");
    assert.match(seenSpawnEnv.DATA_DIR, /ninerouter\/data$/);
    assert.match(seenSpawnEnv.NODE_PATH, /ninerouter\/data\/runtime\/node_modules/);
    assert.equal(process.env.DATA_DIR, originalDataDir);
    assert.ok(seenSpawnEnv.INITIAL_PASSWORD);
    assert.ok(routes.has(`GET ${PREFIX}/*path`));
    assert.equal(typeof upgradeHandler, "function");
    assert.equal((await healthHandler()).healthy, true);
    assert.ok(listedKeys);
    assert.ok(createdKey);

    const secrets = JSON.parse(await fs.readFile(path.join(preparedDir, "secrets.json"), "utf8"));
    assert.equal(secrets.apiKey, "sk-test-key");

    const proxy = routes.get(`GET ${PREFIX}/*path`);
    const proxyServer = createServer((req, res) => proxy(req, res));
    proxyServer.listen(0, "127.0.0.1");
    await once(proxyServer, "listening");
    t.after(() => proxyServer.close());

    const models = await proxyRequest(proxyServer.address().port, `${PREFIX}/v1/models`, {
      host: "public.example",
      authorization: "Bearer sk-test-key",
      cookie: "wt_session=secret; theme=dark",
      "x-forwarded-for": "203.0.113.4",
    });
    assert.equal(models.response.statusCode, 200);
    assert.equal(seenRequest.url, "/v1/models");
    assert.equal(seenRequest.headers.authorization, "Bearer sk-test-key");
    assert.equal(seenRequest.headers.cookie, "theme=dark");
    assert.equal(seenRequest.headers["x-forwarded-for"], undefined);

    const dashboard = await proxyRequest(proxyServer.address().port, `${PREFIX}/dashboard`);
    assert.equal(dashboard.response.statusCode, 200);
    assert.match(dashboard.body, /src="\/9router\/_next\/static\/app\.js"/);

    const redirect = await proxyRequest(proxyServer.address().port, `${PREFIX}/api/auth/status`);
    assert.equal(redirect.response.statusCode, 302);
    assert.equal(redirect.response.headers.location, `${PREFIX}/dashboard`);
    assert.match(redirect.response.headers["set-cookie"][0], new RegExp(`Path=${PREFIX}/`));

    const denied = new PassThrough();
    assert.equal(
      upgradeHandler(
        { url: `${PREFIX}/ws?model=x`, headers: { host: "public.example", cookie: "wt_session=secret" } },
        denied,
        Buffer.alloc(0),
      ),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(seenUpgrade.url, "/ws?model=x");
    assert.equal(seenUpgrade.headers.cookie, undefined);
    assert.equal(upgradeHandler({ url: "/ws", headers: { host: "public.example" } }, denied, Buffer.alloc(0)), false);
  } finally {
    await cleanup?.();
  }
  assert.equal((await healthHandler()).healthy, false);
  assert.ok(logs.some((line) => line.includes("API base URL")));
});

test("gateway failure leaves the host alive and returns 503", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ninerouter-offline-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const routes = new Map();
  let healthHandler;
  const logs = [];
  const cleanup = await createNinerouterModule({
    prepare: async () => { throw new Error("npm offline"); },
    log: (line) => logs.push(line),
    env: {},
  }).setup({
    config: { homeDir, port: 24723, secureCookie: false },
    http: { route: (method, route, handler) => routes.set(`${method} ${route}`, handler) },
    websocket: { onUpgrade() {} },
    health: { register: (handler) => { healthHandler = handler; } },
  });
  assert.ok(routes.has(`GET ${PREFIX}/*path`));
  assert.equal((await healthHandler()).healthy, false);
  assert.ok(logs.some((line) => line.includes("npm offline")));

  const proxy = routes.get(`GET ${PREFIX}/*path`);
  const server = createServer((req, res) => proxy(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const status = await new Promise((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port: server.address().port, path: `${PREFIX}/v1/models` }, (response) => {
      response.resume();
      response.on("end", () => { resolve(response.statusCode); server.close(); });
    });
    client.on("error", reject);
    client.end();
  });
  assert.equal(status, 503);
  await cleanup();
});

test("readiness retries unsuccessful responses and rejects on child error", async (t) => {
  let count = 0;
  const server = createServer((_req, res) => res.writeHead(++count === 1 ? 503 : 200).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const child = { exitCode: null, signalCode: null, on() {}, once() {}, off() {} };
  await waitReady(child, server.address().port, 2000);
  assert.ok(count >= 2);
});
