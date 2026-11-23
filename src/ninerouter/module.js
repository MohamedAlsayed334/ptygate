import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

import { logger } from "../logger.js";

export const PREFIX = "/9router";
const DEFAULT_VERSION = "latest";
const LATEST_URL = "https://registry.npmjs.org/9router/latest";
const STARTUP_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 15_000;
const REWRITE_LIMIT = 8 * 1024 * 1024;

const newSecret = () => crypto.randomBytes(32).toString("hex");
const newPassword = () => crypto.randomBytes(18).toString("base64url");

function readJsonFile(file) {
  return fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
}

async function writePrivateFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

/** 9router derives its CLI token from DATA_DIR/machine-id and DATA_DIR/auth/cli-secret. */
export function computeCliToken(rawMachineId, cliSecret) {
  return crypto
    .createHash("sha256")
    .update(`${rawMachineId}9r-cli-auth${cliSecret}`)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Persist a stable identity for the managed 9router server and return the token
 * ptygate uses for its private /api/* calls.
 */
export async function ensureIdentity(installDir, env = process.env) {
  const file = path.join(installDir, "secrets.json");
  const stored = await readJsonFile(file);
  const dataDir = path.join(installDir, "data");

  const identity = {
    dataDir,
    rawMachineId: env.NINEROUTER_MACHINE_ID || stored.machineId || crypto.randomUUID(),
    cliSecret: env.NINEROUTER_CLI_SECRET || stored.cliSecret || newSecret(),
    dashboardPassword: env.NINEROUTER_INITIAL_PASSWORD || stored.dashboardPassword || newPassword(),
    apiKey: stored.apiKey || "",
  };
  identity.cliToken = computeCliToken(identity.rawMachineId, identity.cliSecret);

  await writePrivateFile(path.join(dataDir, "machine-id"), `${identity.rawMachineId}\n`);
  await writePrivateFile(path.join(dataDir, "auth", "cli-secret"), `${identity.cliSecret}\n`);
  await writePrivateFile(
    file,
    JSON.stringify(
      {
        machineId: identity.rawMachineId,
        cliSecret: identity.cliSecret,
        dashboardPassword: identity.dashboardPassword,
        apiKey: identity.apiKey,
      },
      null,
      2,
    ) + "\n",
  );
  return identity;
}

export async function saveApiKey(installDir, apiKey) {
  const file = path.join(installDir, "secrets.json");
  const stored = await readJsonFile(file);
  stored.apiKey = apiKey;
  await writePrivateFile(
    file,
    JSON.stringify(stored, null, 2) + "\n",
  );
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

/** Resolve the npm `latest` dist-tag to a concrete version so state stays truthful. */
export async function resolveLatestVersion(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(LATEST_URL, {
    headers: { accept: "application/json", "user-agent": "ptygate-ninerouter-installer" },
  });
  if (!response.ok) throw new Error(`Could not fetch 9router version info (HTTP ${response.status})`);
  const body = await response.json();
  if (!body?.version || typeof body.version !== "string") {
    throw new Error("npm registry did not return a 9router version");
  }
  return body.version;
}

/**
 * Install the published npm package into HOME so ptygate never needs a global
 * npm prefix. An existing install is reused when it matches the pinned version
 * or when update checks are explicitly disabled.
 */
export async function prepareInstall(installDir, options = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    spawnProcess = spawn,
    log = (...args) => logger.log(...args),
  } = options;
  const requested = env.NINEROUTER_VERSION || DEFAULT_VERSION;
  const skipUpdate = env.NINEROUTER_SKIP_UPDATE === "1";
  const serverPath = path.join(installDir, "node_modules", "9router", "app", "custom-server.js");
  const statePath = path.join(installDir, "install.json");

  await fs.mkdir(installDir, { recursive: true });
  const packagePath = path.join(installDir, "package.json");
  if (!fsSync.existsSync(packagePath)) {
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ name: "ptygate-ninerouter", private: true, version: "1.0.0" }, null, 2)}\n`,
    );
  }

  let state = await readJsonFile(statePath);
  const installed = await fs.stat(serverPath).then(
    (stat) => stat.isFile(),
    () => false,
  );
  if (installed && skipUpdate) {
    return { cwd: path.dirname(serverPath), serverPath, version: state.version || requested };
  }

  let version = requested;
  let versionCheckFailed = false;
  if (requested === "latest") {
    try {
      version = await resolveLatestVersion(fetchImpl);
    } catch (error) {
      if (!installed) throw new Error(`Could not resolve latest 9router version: ${error.message}`);
      versionCheckFailed = true;
      version = state.version || requested;
      log(`[9router] latest-version check failed, reusing installed package: ${error.message}`);
    }
  }
  const upToDate = installed &&
    (versionCheckFailed || (state.arch === process.arch && state.version === version));

  if (upToDate) {
    return { cwd: path.dirname(serverPath), serverPath, version: state.version || version };
  }

  const tmpDir = path.join(path.dirname(installDir), "tmp");
  await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
  const npmEnv = {
    ...env,
    DATA_DIR: path.join(installDir, "data"),
    TMPDIR: env.TMPDIR || tmpDir,
    npm_config_cache: env.npm_config_cache || path.join(path.dirname(installDir), ".npm"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  log(`[9router] installing 9router@${version} into ${installDir}`);
  let reused = false;
  try {
    await runCommand(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--prefix", installDir, "--no-save", "--omit=dev", `9router@${version}`],
      { cwd: installDir, env: npmEnv },
      spawnProcess,
    );
  } catch (error) {
    if (!installed) throw error;
    reused = true;
    log(`[9router] npm install failed, reusing installed package: ${error.message}`);
  }
  await fs.access(serverPath);
  const installedVersion = reused ? state.version || version : version;
  state = {
    version: installedVersion,
    arch: process.arch,
    installedAt: new Date().toISOString(),
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  log(`[9router] installed 9router@${installedVersion}`);
  return { cwd: path.dirname(serverPath), serverPath, version: installedVersion };
}

/**
 * 9router's published tarball omits sql.js' wasm from its bundled app, and its
 * own CLI repairs that at startup via hooks/sqliteRuntime.js before spawning
 * custom-server.js with an extended NODE_PATH. We bypass the CLI, so do the
 * same here; otherwise no SQLite driver is found on Node 24 and every API
 * route returns 500.
 */
export async function prepareChildEnv({ serverPath, dataDir, env = process.env, log = () => {} }) {
  const packageRoot = path.dirname(path.dirname(serverPath));
  const hookPath = path.join(packageRoot, "hooks", "sqliteRuntime.js");
  const childEnv = { ...env, DATA_DIR: dataDir };
  if (!fsSync.existsSync(hookPath)) return childEnv;

  let hooks;
  try {
    hooks = createRequire(path.join(packageRoot, "package.json"))(hookPath);
  } catch (error) {
    log(`[9router] could not load SQLite runtime hook: ${error.message}`);
    return childEnv;
  }

  // Both hook functions read DATA_DIR from process.env (not from their
  // arguments). Scope the change so it cannot leak into the rest of ptygate.
  const previousDataDir = process.env.DATA_DIR;
  let runtimeEnv = childEnv;
  try {
    process.env.DATA_DIR = dataDir;
    try {
      hooks.ensureSqliteRuntime?.({ silent: true });
    } catch (error) {
      log(`[9router] SQLite runtime self-check failed: ${error.message}`);
    }
    try {
      if (hooks.buildEnvWithRuntime) runtimeEnv = hooks.buildEnvWithRuntime(childEnv);
    } catch (error) {
      log(`[9router] could not extend NODE_PATH: ${error.message}`);
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }

  // The server resolves the bundled sql.js before NODE_PATH, so mirror the
  // wasm the hook installs into the runtime dir back into the bundled copy.
  const bundledWasm = path.join(packageRoot, "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (!fsSync.existsSync(bundledWasm)) {
    const runtimeWasm = path.join(dataDir, "runtime", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
    if (fsSync.existsSync(runtimeWasm)) {
      try {
        await fs.mkdir(path.dirname(bundledWasm), { recursive: true });
        await fs.copyFile(runtimeWasm, bundledWasm);
      } catch (error) {
        log(`[9router] could not restore sql.js wasm: ${error.message}`);
      }
    }
  }
  return runtimeEnv;
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
  const raw = env.NINEROUTER_PORT;
  if (!raw) return freeLoopbackPort();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("NINEROUTER_PORT must be an integer between 1024 and 65535");
  }
  return port;
}

export function waitReady(child, port, timeoutMs = STARTUP_TIMEOUT_MS) {
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
      finish(new Error(`9router exited during startup (code ${code}, signal ${signal})`));
    const spawnFailed = (error) => finish(error);
    child.once("exit", exited);
    child.once("error", spawnFailed);
    const timer = setInterval(() => {
      const request = http.request(
        { host: "127.0.0.1", port, path: "/api/health", method: "GET" },
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
      () => finish(new Error(`9router did not become ready within ${Math.round(timeoutMs / 1000)}s`)),
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

/** Small JSON helper for ptygate-to-9router management calls over loopback. */
export function requestJson({ port, path: requestPath, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: {
          ...headers,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text below */ }
          resolve({ statusCode: response.statusCode ?? 500, headers: response.headers, body: parsed, text });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("9router management request timed out")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function rewriteHeaders(headers, prefix = PREFIX, secure = false) {
  const out = { ...headers };
  delete out.connection;
  delete out["keep-alive"];
  delete out["transfer-encoding"];
  if (out.location) {
    out.location = out.location.replace(/^\/(?!9router(?:\/|$))/i, `${prefix}/`);
  }
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

export function forwardHeaders(req) {
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "proxy-authorization" ||
      lower.startsWith("x-9r-") ||
      lower === "x-forwarded-for" ||
      lower === "x-real-ip"
    ) {
      delete headers[key];
    }
  }
  if (headers.cookie) {
    const cookies = headers.cookie
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !/^wt_session=/i.test(part));
    if (cookies.length) headers.cookie = cookies.join("; ");
    else delete headers.cookie;
  }
  // Buffering rewriteable responses needs plain text, not compressed bytes.
  headers["accept-encoding"] = "identity";
  return headers;
}

/** Rewrite root-relative dashboard/API paths emitted by Next.js into the mount prefix. */
export function rewriteBody(body, prefix = PREFIX) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  return text.replace(
    /(["'`(])\/(?!9router(?:\/|["'`)]))(?=(?:_next|api|dashboard|login|v1|v1beta|codex|responses|images|favicon|assets|static)(?:[\/"'?#]))/g,
    (_match, lead) => `${lead}${prefix}/`,
  );
}

function isRewriteable(contentType) {
  return /text\/html|javascript|ecmascript|text\/css/i.test(String(contentType || ""));
}

export function createProxy({ origin, prefix = PREFIX, secure = false }) {
  return (req, res) => {
    if (req.url === prefix) {
      res.writeHead(308, { location: `${prefix}/` }).end();
      return;
    }
    const target = req.url.slice(prefix.length) || "/";
    const headers = forwardHeaders(req);
    const client = http.request(
      `${origin}${target}`,
      { method: req.method, headers },
      (upstream) => {
        const responseHeaders = rewriteHeaders(upstream.headers, prefix, secure);
        const shouldRewrite = isRewriteable(responseHeaders["content-type"]) &&
          (upstream.statusCode ?? 500) < 400;
        if (!shouldRewrite) {
          res.writeHead(upstream.statusCode || 502, responseHeaders);
          upstream.pipe(res);
          return;
        }

        const declared = Number(responseHeaders["content-length"]);
        if (Number.isSafeInteger(declared) && declared > REWRITE_LIMIT) {
          res.writeHead(upstream.statusCode || 502, responseHeaders);
          upstream.pipe(res);
          return;
        }

        const chunks = [];
        let size = 0;
        let overflowed = false;
        upstream.on("data", (chunk) => {
          size += chunk.length;
          if (size > REWRITE_LIMIT) {
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
          const body = Buffer.from(rewriteBody(Buffer.concat(chunks), prefix), "utf8");
          delete responseHeaders["content-encoding"];
          responseHeaders["content-length"] = String(body.length);
          res.writeHead(upstream.statusCode || 200, responseHeaders);
          res.end(body);
        });
      },
    );
    client.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("9router gateway unavailable\n");
    });
    req.pipe(client);
  };
}

async function ensureApiKey(installDir, identity, port, env, log) {
  const authHeaders = { "x-9r-cli-token": identity.cliToken };
  const listed = await requestJson({ port, path: "/api/keys", headers: authHeaders });
  if (listed.statusCode !== 200 || !Array.isArray(listed.body?.keys)) {
    throw new Error(`Could not list 9router API keys (HTTP ${listed.statusCode})`);
  }
  const keys = listed.body.keys;
  const requested = env.NINEROUTER_API_KEY;
  let apiKey = requested && keys.some((key) => key.key === requested && key.isActive !== false)
    ? requested
    : null;
  if (!apiKey) {
    apiKey = keys.find((key) => key.name === "ptygate" && key.isActive !== false)?.key ||
      keys.find((key) => key.isActive !== false)?.key;
  }
  if (!apiKey) {
    const created = await requestJson({
      port,
      path: "/api/keys",
      method: "POST",
      headers: authHeaders,
      body: { name: "ptygate" },
    });
    if (created.statusCode >= 300 || !created.body?.key) {
      throw new Error(`Could not create 9router API key (HTTP ${created.statusCode})`);
    }
    apiKey = created.body.key;
    log("[9router] created a new API key");
  }
  if (apiKey !== identity.apiKey) {
    await saveApiKey(installDir, apiKey);
  }
  return apiKey;
}

export function createNinerouterModule({
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  prepare = (installDir, options) => prepareInstall(installDir, { spawnProcess, fetchImpl, ...options }),
  selectPortNumber = selectPort,
  log = (...args) => logger.log(...args),
  env = process.env,
} = {}) {
  return {
    id: "ninerouter",
    prefix: PREFIX,
    async setup({ http: routes, websocket, health, config }) {
      let active = null;
      let startupError = null;
      let child = null;
      let stopping = null;
      let secrets = null;

      health.register(async () => {
        if (!active) return { healthy: false, error: startupError?.message || "not started" };
        return {
          healthy: active.child.exitCode === null && active.child.signalCode === null,
          version: active.version,
        };
      });

      const dispatch = (req, res) => {
        if (active) return active.proxy(req, res);
        res.writeHead(503, { "content-type": "text/plain" })
          .end(`9router gateway unavailable: ${startupError?.message || "starting"}\n`);
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
        const installDir = path.join(config.homeDir, ".ptygate", "ninerouter");
        await fs.mkdir(installDir, { recursive: true });
        const prepared = await prepare(installDir, { env, log });
        secrets = await ensureIdentity(installDir, env);
        const port = await selectPortNumber(env);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error("9router loopback port must be between 1024 and 65535");
        }

        const runtimeEnv = await prepareChildEnv({
          serverPath: prepared.serverPath,
          dataDir: secrets.dataDir,
          env,
          log,
        });
        const tmpDir = path.join(config.homeDir, "tmp");
        await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
        child = spawnProcess(process.execPath, ["--max-old-space-size=384", prepared.serverPath], {
          cwd: prepared.cwd,
          env: {
            ...runtimeEnv,
            PORT: String(port),
            HOSTNAME: "127.0.0.1",
            DATA_DIR: secrets.dataDir,
            INITIAL_PASSWORD: secrets.dashboardPassword,
            NODE_ENV: "production",
            TMPDIR: env.TMPDIR || tmpDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
        const redact = (text) => {
          let redacted = text;
          for (const secret of [secrets.apiKey, secrets.dashboardPassword, secrets.cliToken]) {
            if (secret) redacted = redacted.split(secret).join("[redacted]");
          }
          return redacted;
        };
        const forward = (stream) => {
          if (!stream) return;
          let pending = "";
          stream.on("data", (chunk) => {
            pending += chunk.toString();
            let index;
            while ((index = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              log(`[9router] ${redact(line)}`);
            }
            if (pending.length > 8192) {
              log(`[9router] ${redact(pending)}`);
              pending = "";
            }
          });
          stream.on("end", () => {
            if (pending) log(`[9router] ${redact(pending)}`);
            pending = "";
          });
        };
        forward(child.stdout);
        forward(child.stderr);
        await waitReady(child, port);
        secrets.apiKey = await ensureApiKey(installDir, secrets, port, env, log);

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
          env.NINEROUTER_PUBLIC_URL?.replace(/\/+$/, "") ||
          `${config.secureCookie ? "https" : "http"}://localhost:${config.port}`;
        log(`[9router] ${prepared.version} ready on 127.0.0.1:${port}`);
        log(`[9router] API base URL: ${publicOrigin}${PREFIX}/v1`);
        log(`[9router] API token (Authorization: Bearer ...): ${secrets.apiKey}`);
        log(`[9router] Dashboard: ${publicOrigin}${PREFIX}/dashboard`);
        log(`[9router] Dashboard password: ${secrets.dashboardPassword}`);
      } catch (error) {
        startupError = error;
        if (child && !active) await stopChild(child);
        log(`[9router] gateway unavailable: ${error.message}`);
      }

      return async () => {
        if (stopping) return stopping;
        stopping = child ? stopChild(child) : Promise.resolve();
        return stopping;
      };
    },
  };
}
