import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  PREFIX,
  createCliproxyApiModule,
  detectLibc,
  prepareInstall,
  renderConfig,
  rewriteManagementHtml,
  selectAsset,
  waitReady,
} from "./module.js";

function fakeRelease(arch) {
  const archName = arch === "arm64" ? "aarch64" : "amd64";
  return {
    tag_name: "v8.0.80",
    assets: [
      { name: "checksums.txt", browser_download_url: "https://example.test/checksums.txt" },
      { name: `CLIProxyAPI_8.0.80_linux_${archName}.tar.gz`, browser_download_url: "https://example.test/glibc.tar.gz" },
      { name: `CLIProxyAPI_8.0.80_linux_${archName}_no-plugin.tar.gz`, browser_download_url: "https://example.test/musl.tar.gz" },
    ],
  };
}

test("selectAsset picks the matching glibc or musl Linux build", () => {
  assert.equal(selectAsset(fakeRelease("arm64"), "arm64", "glibc").name, "CLIProxyAPI_8.0.80_linux_aarch64.tar.gz");
  assert.equal(selectAsset(fakeRelease("arm64"), "arm64", "musl").name, "CLIProxyAPI_8.0.80_linux_aarch64_no-plugin.tar.gz");
  assert.equal(selectAsset(fakeRelease("x64"), "x64", "glibc").name, "CLIProxyAPI_8.0.80_linux_amd64.tar.gz");
  assert.throws(() => selectAsset(fakeRelease("x64"), "ia32", "glibc"), /no Linux build/);
});

test("renderConfig uses the v8 layout with a loopback listener and client key", () => {
  const yaml = renderConfig({ port: 8317, apiKey: "client-key", managementKey: "mgmt-key" });
  assert.match(yaml, /^config-version: 8$/m);
  assert.match(yaml, /  host: "127\.0\.0\.1"/);
  assert.match(yaml, /  port: 8317/);
  assert.match(yaml, /  secret-key: "mgmt-key"/);
  assert.match(yaml, /    - "client-key"/);
  assert.doesNotMatch(yaml, /^host:/m);
});

test("rewriteManagementHtml seeds the /cpa API base before the app loads", () => {
  const html = rewriteManagementHtml("<!doctype html><html><head><title>x</title></head></html>", "/cpa").toString("utf8");
  assert.match(html, /<head><script>/);
  assert.match(html, /var base=location\.origin\+"\/cpa"/);
  assert.match(html, /\["cli-proxy-auth","isLoggedIn","managementKey"\]/);
  assert.match(html, /setItem\("apiBase",JSON\.stringify\(base\)\)/);
  assert.match(html, /setItem\("apiUrl",JSON\.stringify\(base\)\)/);
  assert.match(html, /<\/script><title>x<\/title>/);
});

test("module installs config, proxies /cpa/* with the API key, and forwards WebSocket upgrades", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-module-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));

  let seenRequest;
  let seenUpgrade;
  let seenSpawnArgs;
  let seenBinary;
  const upstream = createServer((req, res) => {
    seenRequest = { url: req.url, headers: req.headers };
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      return;
    }
    if (req.url.startsWith("/management.html")) {
      const body = "<!doctype html><html><head><title>cpa</title></head></html>";
      res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(body) }).end(body);
      return;
    }
    res.writeHead(302, {
      location: "/management.html",
      "set-cookie": ["panel=1; Path=/; HttpOnly"],
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

  const routes = new Map();
  const registrationOrder = [];
  let upgradeHandler;
  let healthHandler;
  let preparedDir;
  let cleanup;
  try {
    cleanup = await createCliproxyApiModule({
      prepare: async (dir) => {
        preparedDir = dir;
        return { cwd: dir, binary: path.join(dir, "cli-proxy-api"), version: "v8.0.80" };
      },
      selectPortNumber: async () => port,
      spawnProcess: (binary, args) => {
        seenBinary = binary;
        seenSpawnArgs = args;
        return child;
      },
      log() {},
    }).setup({
      config: { homeDir, port: 24723, secureCookie: false },
      http: { route: (method, route, handler) => { registrationOrder.push(route); routes.set(`${method} ${route}`, handler); } },
      websocket: { onUpgrade: (handler) => { upgradeHandler = handler; } },
      health: { register: (handler) => { registrationOrder.push(`${PREFIX}/healthz`); healthHandler = handler; } },
    });

    assert.ok(registrationOrder.indexOf(`${PREFIX}/healthz`) < registrationOrder.indexOf(`${PREFIX}/*path`));
    assert.equal(preparedDir, path.join(homeDir, ".ptygate", "cliproxyapi"));
    assert.match(seenBinary, /cli-proxy-api$/);
    assert.equal(seenSpawnArgs[0], "--config");
    assert.match(seenSpawnArgs[1], /config\.yaml$/);
    assert.ok(routes.has(`POST ${PREFIX}/*path`));
    assert.equal(typeof upgradeHandler, "function");
    assert.equal((await healthHandler()).healthy, true);

    const secrets = JSON.parse(await fs.readFile(path.join(preparedDir, "secrets.json"), "utf8"));
    const yaml = await fs.readFile(path.join(preparedDir, "config.yaml"), "utf8");
    assert.match(yaml, new RegExp(`    - "${secrets.apiKey}"`));
    assert.match(yaml, new RegExp(`  port: ${port}`));

    const proxy = routes.get(`GET ${PREFIX}/*path`);
    const proxyServer = createServer((req, res) => proxy(req, res));
    proxyServer.listen(0, "127.0.0.1");
    await once(proxyServer, "listening");
    t.after(() => proxyServer.close());
    const result = await new Promise((resolve, reject) => {
      const client = request(
        {
          host: "127.0.0.1",
          port: proxyServer.address().port,
          path: `${PREFIX}/v0/management/config?x=1`,
          headers: {
            host: "public.example",
            authorization: `Bearer ${secrets.apiKey}`,
            cookie: "wt_session=secret; panel=1",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response));
        },
      );
      client.on("error", reject);
      client.end();
    });
    assert.equal(result.statusCode, 302);
    assert.equal(result.headers.location, `${PREFIX}/management.html`);
    assert.match(result.headers["set-cookie"][0], new RegExp(`Path=${PREFIX}/`));
    assert.equal(seenRequest.url, "/v0/management/config?x=1");
    assert.equal(seenRequest.headers.authorization, `Bearer ${secrets.apiKey}`);
    assert.equal(seenRequest.headers.cookie, "panel=1");

    const page = await new Promise((resolve, reject) => {
      const client = request(
        {
          host: "127.0.0.1",
          port: proxyServer.address().port,
          path: `${PREFIX}/management.html?x=1`,
          headers: { host: "public.example" },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve({ response, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      client.on("error", reject);
      client.end();
    });
    assert.equal(page.response.statusCode, 200);
    assert.match(page.body, /var base=location\.origin\+"\/cpa"/);
    assert.match(page.body, /\["cli-proxy-auth","isLoggedIn","managementKey"\]/);
    assert.match(page.body, /setItem\("apiBase",JSON\.stringify\(base\)\)/);
    assert.equal(page.response.headers["content-length"], String(Buffer.byteLength(page.body)));
    assert.equal(seenRequest.url, "/management.html?x=1");
    assert.equal(seenRequest.headers["accept-encoding"], "identity");

    const denied = new PassThrough();
    assert.equal(
      upgradeHandler(
        { url: `${PREFIX}/v1/realtime?model=x`, headers: { host: "public.example", cookie: "wt_session=secret" } },
        denied,
        Buffer.alloc(0),
      ),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(seenUpgrade.url, "/v1/realtime?model=x");
    assert.equal(seenUpgrade.headers.cookie, undefined);
    assert.equal(upgradeHandler({ url: "/ws", headers: { host: "public.example" } }, denied, Buffer.alloc(0)), false);
  } finally {
    await cleanup?.();
  }
  assert.equal((await healthHandler()).healthy, false);
});

test("prepareInstall downloads, verifies and extracts a release, then reuses it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, "cli-proxy-api"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  const tarPath = path.join(root, "payload.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", stage, "cli-proxy-api"]);
  const digest = createHash("sha256").update(fsSync.readFileSync(tarPath)).digest("hex");
  const arch = process.arch === "arm64" ? "aarch64" : "amd64";
  const assetName = `CLIProxyAPI_8.0.80_linux_${arch}${detectLibc() === "musl" ? "_no-plugin" : ""}.tar.gz`;

  let downloads = 0;
  const server = createServer((req, res) => {
    const self = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/release") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        tag_name: "v8.0.80",
        assets: [
          { name: assetName, browser_download_url: `${self}/${assetName}` },
          { name: "checksums.txt", browser_download_url: `${self}/checksums.txt` },
        ],
      }));
    } else if (req.url === `/${assetName}`) {
      downloads += 1;
      res.end(fsSync.readFileSync(tarPath));
    } else if (req.url === "/checksums.txt") {
      res.end(`${digest}  ${assetName}\n`);
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const fetchImpl = async (url) =>
    fetch(url.includes("/releases/latest") ? `http://127.0.0.1:${server.address().port}/release` : url);

  const installDir = path.join(root, "install");
  const result = await prepareInstall(installDir, { env: {}, fetchImpl, log() {} });
  assert.equal(result.version, "v8.0.80");
  assert.match(await fs.readFile(path.join(installDir, "cli-proxy-api"), "utf8"), /echo ok/);
  assert.ok(fsSync.statSync(path.join(installDir, "cli-proxy-api")).mode & 0o111);
  assert.equal(downloads, 1);

  await prepareInstall(installDir, { env: {}, fetchImpl, log() {} });
  assert.equal(downloads, 1);
});

test("gateway failure leaves the host alive and returns 503", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-offline-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const routes = new Map();
  let healthHandler;
  const logs = [];
  const cleanup = await createCliproxyApiModule({
    prepare: async () => { throw new Error("network down"); },
    log: (line) => logs.push(line),
  }).setup({
    config: { homeDir, port: 24723, secureCookie: false },
    http: { route: (method, route, handler) => routes.set(`${method} ${route}`, handler) },
    websocket: { onUpgrade() {} },
    health: { register: (handler) => { healthHandler = handler; } },
  });
  assert.ok(routes.has(`GET ${PREFIX}/*path`));
  assert.equal((await healthHandler()).healthy, false);
  assert.ok(logs.some((line) => line.includes("network down")));

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
  await waitReady(child, server.address().port, "test-key", 2000);
  assert.ok(count >= 2);
});
