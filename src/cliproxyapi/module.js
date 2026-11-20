import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { logger } from "../logger.js";

export const PREFIX = "/cpa";
const REPO = "router-for-me/CLIProxyAPI";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const BINARY_NAME = "cli-proxy-api";
const STARTUP_TIMEOUT_MS = 90_000;

/** Detect the libc flavour so we can pick the portable (musl) build on Alpine. */
export function detectLibc() {
  if (fsSync.existsSync("/etc/alpine-release")) return "musl";
  for (const dir of ["/lib", "/usr/lib"]) {
    try {
      if (fsSync.readdirSync(dir).some((name) => name.startsWith("ld-musl-"))) return "musl";
    } catch {
      /* directory missing or unreadable */
    }
  }
  return "glibc";
}

/** Map a Node architecture name to the naming used by CLIProxyAPI release assets. */
export function selectAsset(release, arch = process.arch, libc = detectLibc()) {
  const target = arch === "arm64" ? "aarch64" : arch === "x64" ? "amd64" : null;
  if (!target) throw new Error(`CLIProxyAPI has no Linux build for architecture "${arch}"`);
  const suffix = `linux_${target}${libc === "musl" ? "_no-plugin" : ""}.tar.gz`;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset =
    assets.find((item) => item.name?.endsWith(suffix) && !item.name.includes("no-plugin")) ??
    assets.find((item) => item.name?.endsWith(suffix));
  if (!asset) {
    throw new Error(`CLIProxyAPI ${release?.tag_name ?? "latest"} has no ${suffix} asset`);
  }
  return asset;
}

/** Render the v8 config layout. Legacy top-level keys are intentionally avoided. */
export function renderConfig({ port, apiKey, managementKey, allowRemote = true }) {
  return [
    "config-version: 8",
    "",
    "server:",
    '  host: "127.0.0.1"',
    `  port: ${port}`,
    "",
    "management:",
    `  allow-remote: ${allowRemote ? "true" : "false"}`,
    `  secret-key: ${JSON.stringify(managementKey)}`,
    "  disable-control-panel: false",
    "",
    "access:",
    "  api-keys:",
    `    - ${JSON.stringify(apiKey)}`,
    "",
  ].join("\n");
}

const newSecret = () => crypto.randomBytes(32).toString("base64url");

/**
 * Keys live in a sidecar file because CLIProxyAPI hashes `secret-key` in place
 * on first boot; reading it back from config.yaml would double-hash it.
 */
export async function ensureSecrets(installDir, env = process.env) {
  const file = path.join(installDir, "secrets.json");
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    /* first run */
  }
  const apiKey = env.CLIPROXYAPI_API_KEY || stored.apiKey || newSecret();
  const managementKey = env.CLIPROXYAPI_MANAGEMENT_KEY || stored.managementKey || newSecret();
  if (stored.apiKey !== apiKey || stored.managementKey !== managementKey) {
    await fs.writeFile(file, JSON.stringify({ apiKey, managementKey }, null, 2), { mode: 0o600 });
  }
  await fs.chmod(file, 0o600).catch(() => {});
  return { apiKey, managementKey };
}

async function fetchRelease({ fetchImpl, version, env }) {
  const url = version && version !== "latest"
    ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(version)}`
    : LATEST_URL;
  const headers = {
    "user-agent": "ptygate-cliproxyapi-installer",
    accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`Could not fetch CLIProxyAPI release info (HTTP ${response.status})`);
  }
  return response.json();
}

async function downloadAsset(asset, destination, fetchImpl) {
  const response = await fetchImpl(asset.browser_download_url, {
    headers: { "user-agent": "ptygate-cliproxyapi-installer" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${asset.name} (HTTP ${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(destination));
}

async function verifyChecksum(asset, release, tarPath, fetchImpl) {
  const checksums = release.assets?.find((item) => item.name === "checksums.txt");
  if (!checksums) throw new Error("Release has no checksums.txt; refusing to install an unverified binary");
  const response = await fetchImpl(checksums.browser_download_url, {
    headers: { "user-agent": "ptygate-cliproxyapi-installer" },
  });
  if (!response.ok) throw new Error(`Could not fetch checksums.txt (HTTP ${response.status})`);
  const text = await response.text();
  const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.endsWith(asset.name));
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error(`checksums.txt has no valid entry for ${asset.name}`);
  }
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(tarPath)) hash.update(chunk);
  if (hash.digest("hex").toLowerCase() !== expected.toLowerCase()) {
    throw new Error("CLIProxyAPI checksum mismatch; refusing to install");
  }
}

async function findBinary(dir, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === BINARY_NAME) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findBinary(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function runCommand(command, args, options, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: "inherit", shell: false, ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

async function extractBinary(tarPath, installDir, spawnProcess) {
  const staging = path.join(installDir, `.stage-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    await runCommand("tar", ["-xzf", tarPath, "-C", staging], {}, spawnProcess);
    const source = await findBinary(staging);
    if (!source) throw new Error(`Archive did not contain ${BINARY_NAME}`);
    const target = path.join(installDir, BINARY_NAME);
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o755);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(tarPath, { force: true });
  }
}

/**
 * Download and verify the latest (or pinned) CLIProxyAPI Linux binary.
 * An existing verified install is reused when GitHub cannot be reached.
 */
export async function prepareInstall(installDir, options = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    spawnProcess = spawn,
    log = (...args) => logger.log(...args),
  } = options;
  await fs.mkdir(installDir, { recursive: true });
  const binary = path.join(installDir, BINARY_NAME);
  const statePath = path.join(installDir, "install.json");
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    /* not installed yet */
  }
  const installed = await fs.stat(binary).then(
    (stat) => stat.isFile() && (stat.mode & 0o111) !== 0,
    () => false,
  );
  const pinned = env.CLIPROXYAPI_VERSION || null;
  const skipUpdate = env.CLIPROXYAPI_SKIP_UPDATE === "1";
  let release = null;
  let releaseCheckFailed = false;
  if (!installed || !skipUpdate || pinned) {
    try {
      release = await fetchRelease({ fetchImpl, version: pinned, env });
    } catch (error) {
      if (!installed) throw error;
      releaseCheckFailed = true;
      log(`[cliproxyapi] release check failed, using installed binary: ${error.message}`);
    }
  }
  const targetTag = release?.tag_name ?? state.version ?? null;
  const upToDate =
    installed &&
    (releaseCheckFailed ||
      (skipUpdate && !pinned) ||
      (state.arch === process.arch && (!targetTag || state.version === targetTag)));
  if (!upToDate) {
    if (!release) throw new Error("Cannot determine which CLIProxyAPI build to install");
    const asset = selectAsset(release, process.arch, detectLibc());
    const tarPath = path.join(installDir, `download-${crypto.randomBytes(4).toString("hex")}.tar.gz`);
    log(`[cliproxyapi] installing ${release.tag_name} (${asset.name})`);
    try {
      await downloadAsset(asset, tarPath, fetchImpl);
      await verifyChecksum(asset, release, tarPath, fetchImpl);
      await extractBinary(tarPath, installDir, spawnProcess);
    } finally {
      await fs.rm(tarPath, { force: true });
    }
    await fs.writeFile(
      statePath,
      JSON.stringify(
        { version: release.tag_name, asset: asset.name, arch: process.arch, installedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    log(`[cliproxyapi] installed ${release.tag_name} at ${binary}`);
  }
  await fs.access(binary);
  return { cwd: installDir, binary, version: release?.tag_name ?? state.version ?? "installed" };
}

async function freeLoopbackPort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}

export async function selectPort(env = process.env) {
  const raw = env.CLIPROXYAPI_PORT;
  if (!raw) return freeLoopbackPort();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("CLIPROXYAPI_PORT must be an integer between 1024 and 65535");
  }
  return port;
}

export function waitReady(child, port, apiKey, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(timeout);
      child.off("exit", exited);
      child.off("error", spawnFailed);
      error ? reject(error) : resolve();
    };
    const exited = (code, signal) =>
      finish(new Error(`CLIProxyAPI exited during startup (code ${code}, signal ${signal})`));
    const spawnFailed = (error) => finish(error);
    child.once("exit", exited);
    child.once("error", spawnFailed);
    const timer = setInterval(() => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/models",
          method: "GET",
          headers: { authorization: `Bearer ${apiKey}` },
        },
        (response) => {
          response.resume();
          if ((response.statusCode ?? 500) < 500) finish();
        },
      );
      request.setTimeout(1500, () => request.destroy());
      request.on("error", () => {});
      request.end();
    }, 500);
    const timeout = setTimeout(
      () => finish(new Error(`CLIProxyAPI did not become ready within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  const grace = new Promise((resolve) => setTimeout(resolve, 5000));
  child.kill("SIGTERM");
  await Promise.race([exited, grace]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit").catch(() => {});
    child.kill("SIGKILL");
    await killed;
  }
}

function rewriteHeaders(headers, prefix, secure) {
  const out = { ...headers };
  if (out.location) out.location = out.location.replace(/^\/(?!cpa\/)/i, `${prefix}/`);
  const cookies = out["set-cookie"];
  if (cookies) {
    out["set-cookie"] = (Array.isArray(cookies) ? cookies : [cookies]).map((cookie) => {
      let value = cookie.replace(/;\s*Path=\//i, `; Path=${prefix}/`);
      if (secure && !/(?:^|;)\s*Secure(?:;|$)/i.test(value)) value += "; Secure";
      return value;
    });
  }
  return out;
}

function forwardHeaders(req) {
  const headers = { ...req.headers };
  if (headers.cookie) {
    const cookies = headers.cookie
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !/^wt_session=/i.test(part));
    if (cookies.length) headers.cookie = cookies.join("; ");
    else delete headers.cookie;
  }
  return headers;
}

// The bundled management page derives its API base from window.location.origin.
// Behind the gateway that is the ptygate origin, not the CLIProxyAPI prefix, so
// it would call /v8/management/... at the site root and get a 404. Seed its
// saved API base with the mounted prefix before the app script runs.
export function rewriteManagementHtml(body, prefix = PREFIX) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  const script = `<script>(function(){try{var base=location.origin+${JSON.stringify(prefix)};["cli-proxy-auth","isLoggedIn","managementKey"].forEach(function(k){localStorage.removeItem(k)});localStorage.setItem("apiBase",JSON.stringify(base));localStorage.setItem("apiUrl",JSON.stringify(base));}catch(e){}})();</script>`;
  const patched = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (tag) => `${tag}${script}`) : `${script}${text}`;
  return Buffer.from(patched, "utf8");
}

export function createProxy({ origin, prefix = PREFIX, secure = false }) {
  return (req, res) => {
    if (req.url === prefix) {
      res.writeHead(308, { location: `${prefix}/` }).end();
      return;
    }
    const target = req.url.slice(prefix.length) || "/";
    let targetPath = target;
    try { targetPath = new URL(target, "http://localhost").pathname; } catch { /* use raw target */ }
    const isManagementHtml = targetPath === "/management.html";
    const headers = forwardHeaders(req);
    if (isManagementHtml) headers["accept-encoding"] = "identity";
    const client = http.request(
      `${origin}${target}`,
      { method: req.method, headers },
      (upstream) => {
        const responseHeaders = rewriteHeaders(upstream.headers, prefix, secure);
        if (!isManagementHtml || (upstream.statusCode ?? 500) >= 400) {
          res.writeHead(upstream.statusCode || 502, responseHeaders);
          upstream.pipe(res);
          return;
        }
        const chunks = [];
        let size = 0;
        let overflowed = false;
        upstream.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            if (!overflowed) {
              overflowed = true;
              res.writeHead(upstream.statusCode || 502, responseHeaders);
              for (const prior of chunks) res.write(prior);
              chunks.length = 0;
            }
            res.write(chunk);
          } else {
            chunks.push(chunk);
          }
        });
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        upstream.on("end", () => {
          if (overflowed) {
            res.end();
            return;
          }
          const body = rewriteManagementHtml(Buffer.concat(chunks), prefix);
          delete responseHeaders["content-encoding"];
          responseHeaders["content-length"] = String(body.length);
          res.writeHead(upstream.statusCode || 200, responseHeaders);
          res.end(body);
        });
      },
    );
    client.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("CLIProxyAPI gateway unavailable\n");
    });
    req.pipe(client);
  };
}

export function createCliproxyApiModule({
  spawnProcess = spawn,
  prepare = (installDir, options) => prepareInstall(installDir, { spawnProcess, ...options }),
  selectPortNumber = selectPort,
  fetchImpl = globalThis.fetch,
  log = (...args) => logger.log(...args),
  env = process.env,
} = {}) {
  return {
    id: "cliproxyapi",
    prefix: PREFIX,
    async setup({ http: routes, websocket, health, config }) {
      let active = null;
      let startupError = null;
      let child = null;
      let stopping = null;

      // Health must be registered before the catch-all proxy so it is reachable.
      health.register(async () => {
        if (!active) return { healthy: false, error: startupError?.message || "not started" };
        return {
          healthy: active.child.exitCode === null && active.child.signalCode === null,
          version: active.version,
        };
      });

      // Register routes first: a failed gateway install must not take the
      // terminal down with it. These handlers return 503 until startup works.
      const dispatch = (req, res) => {
        if (active) return active.proxy(req, res);
        res.writeHead(503, { "content-type": "text/plain" })
          .end(`CLIProxyAPI gateway unavailable: ${startupError?.message || "starting"}\n`);
      };
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        routes.route(method, PREFIX, dispatch);
        routes.route(method, `${PREFIX}/*path`, dispatch);
      }
      websocket.onUpgrade((req, socket, head) => {
        let url;
        try {
          url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
        } catch {
          return false;
        }
        if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
        if (!active || !active.port) {
          socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return true;
        }
        const target = `${url.pathname.slice(PREFIX.length) || "/"}${url.search}`;
        const upstream = net.connect(active.port, "127.0.0.1", () => {
          const lines = [
            `GET ${target} HTTP/1.1`,
            `Host: ${req.headers.host || "127.0.0.1"}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
          ];
          for (const [key, value] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (["host", "connection", "upgrade"].includes(lower) || value === undefined) continue;
            if (lower === "cookie") {
              const cookies = String(value)
                .split(";")
                .map((part) => part.trim())
                .filter((part) => part && !/^wt_session=/i.test(part));
              if (cookies.length) lines.push(`Cookie: ${cookies.join("; ")}`);
              continue;
            }
            lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
          }
          upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () =>
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
        );
        socket.on("error", () => upstream.destroy());
        return true;
      });
      try {
        const installDir = path.join(config.homeDir, ".ptygate", "cliproxyapi");
        await fs.mkdir(installDir, { recursive: true });
        const prepared = await prepare(installDir, { env, fetchImpl, log });
        const secrets = await ensureSecrets(installDir, env);
        const port = await selectPortNumber(env);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error("CLIProxyAPI loopback port must be between 1024 and 65535");
        }
        const configPath = path.join(installDir, "config.yaml");
        const rendered = renderConfig({ port, ...secrets });
        const previous = await fs.readFile(configPath, "utf8").catch(() => null);
        if (previous !== rendered) await fs.writeFile(configPath, rendered, { mode: 0o600 });
        await fs.chmod(configPath, 0o600).catch(() => {});

        const tmpDir = path.join(config.homeDir, "tmp");
        await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
        child = spawnProcess(prepared.binary, ["--config", configPath], {
          cwd: prepared.cwd,
          env: { ...env, TMPDIR: env.TMPDIR || tmpDir },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
        const redact = (text) =>
          text.split(secrets.apiKey).join("[redacted]").split(secrets.managementKey).join("[redacted]");
        const forward = (stream) => {
          if (!stream) return;
          let pending = "";
          stream.on("data", (chunk) => {
            pending += chunk.toString();
            let index;
            while ((index = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              log(`[cliproxyapi] ${redact(line)}`);
            }
            if (pending.length > 8192) {
              log(`[cliproxyapi] ${redact(pending)}`);
              pending = "";
            }
          });
          stream.on("end", () => {
            if (pending) log(`[cliproxyapi] ${redact(pending)}`);
            pending = "";
          });
        };
        forward(child.stdout);
        forward(child.stderr);
        await waitReady(child, port, secrets.apiKey);

        active = {
          port,
          child,
          version: prepared.version,
          proxy: createProxy({
            origin: `http://127.0.0.1:${port}`,
            prefix: PREFIX,
            secure: config.secureCookie,
          }),
        };
        const publicOrigin =
          env.CLIPROXYAPI_PUBLIC_URL?.replace(/\/+$/, "") ||
          `${config.secureCookie ? "https" : "http"}://localhost:${config.port}`;
        log(`[cliproxyapi] ${prepared.version} ready on 127.0.0.1:${port}`);
        log(`[cliproxyapi] API base URL: ${publicOrigin}${PREFIX}/v1`);
        log(`[cliproxyapi] API token (Authorization: Bearer ...): ${secrets.apiKey}`);
        log(`[cliproxyapi] Management key: ${secrets.managementKey}`);
      } catch (error) {
        startupError = error;
        if (child && !active) await stopChild(child);
        log(`[cliproxyapi] gateway unavailable: ${error.message}`);
      }

      return async () => {
        if (stopping) return stopping;
        stopping = child ? stopChild(child) : Promise.resolve();
        return stopping;
      };
    },
  };
}
