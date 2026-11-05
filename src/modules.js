import express from "express";
import { isIpAllowed } from "./ip_policy.js";
import { createTerminalModule } from "./terminal/module.js";

/** Build the host app and register explicitly-owned application modules. */
export async function createModuleHost(config, services, rootDir, modules = [createTerminalModule()]) {
  const app = express();
  const reservedPrefixes = new Map([["/healthz", "host"]]);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (isIpAllowed(req.socket.remoteAddress, config)) return next();
    res.status(403).type("text/plain").send("Forbidden: this terminal only accepts connections from the configured IP allowlist.\nDisable ALLOW_PRIVATE_ONLY or configure ALLOWED_IPS to change that.\n");
  });
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

  const ids = new Set();
  const owners = new Map();
  const httpRoutes = new Map([
    ["GET /healthz", "host"],
  ]);
  const wsRoutes = new Map();
  const cleanups = [];
  for (const mod of modules) {
    if (!mod || typeof mod.id !== "string" || !mod.id || ids.has(mod.id)) throw new Error(`Invalid or duplicate app module id: ${mod?.id}`);
    if (typeof mod.prefix !== "string" || !mod.prefix.startsWith("/") || (mod.prefix.length > 1 && mod.prefix.endsWith("/"))) throw new Error(`Module ${mod.id} must declare a normalized absolute route prefix`);
    if (mod.prefix !== "/") {
      for (const [reserved, owner] of reservedPrefixes) {
        if (mod.prefix === reserved || mod.prefix.startsWith(`${reserved}/`) || reserved.startsWith(`${mod.prefix}/`)) {
          throw new Error(`Route ownership conflict: module ${mod.id} prefix ${mod.prefix} overlaps ${owner} route ${reserved}`);
        }
      }
    }
    for (const [prefix, owner] of owners) if (prefix !== "/" && mod.prefix !== "/" && (mod.prefix === prefix || mod.prefix.startsWith(`${prefix}/`) || prefix.startsWith(`${mod.prefix}/`))) throw new Error(`Route ownership conflict: module ${mod.id} prefix ${mod.prefix} overlaps module ${owner} prefix ${prefix}`);
    ids.add(mod.id); owners.set(mod.prefix, mod.id);
    const routeKey = (method, route) => `${method.toUpperCase()} ${route}`;
    const moduleServices = services.forModule?.(mod.id) ?? {};
    const registeredWebSockets = [];
    const context = Object.freeze({
      config: Object.freeze({
        port: config.port,
        host: config.host,
        ipMode: config.ipMode,
        allowedIps: [...config.allowedIps],
        sessionTtlMs: config.sessionTtlMs,
        secureCookie: config.secureCookie,
        homeDir: config.homeDir,
      }),
      services: Object.freeze({ ...moduleServices }),
      rootDir,
      http: Object.freeze({ route(method, route, ...handlers) {
        if (typeof method !== "string" || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method.toUpperCase())) {
          throw new Error(`Module ${mod.id} registered unsupported HTTP method: ${method}`);
        }
        if (typeof route !== "string" || !route.startsWith("/") || route.includes("?")) {
          throw new Error(`Module ${mod.id} registered invalid HTTP path: ${route}`);
        }
        const key = routeKey(method, route);
        if (httpRoutes.has(key)) throw new Error(`Duplicate HTTP route ${key}: ${httpRoutes.get(key)} and ${mod.id}`);
        if (!route.startsWith(mod.prefix === "/" ? "/" : `${mod.prefix}/`) && route !== mod.prefix) throw new Error(`Module ${mod.id} cannot register route outside ${mod.prefix}: ${route}`);
        for (const [prefix, owner] of owners) {
          if (owner !== mod.id && prefix !== "/" && (route === prefix || route.startsWith(`${prefix}/`))) {
            throw new Error(`Route ownership conflict: module ${mod.id} cannot register ${route}; it belongs to ${owner} (${prefix})`);
          }
        }
        for (const [reserved, owner] of reservedPrefixes) {
          if (owner !== mod.id && (route === reserved || route.startsWith(`${reserved}/`))) {
            throw new Error(`Route ownership conflict: module ${mod.id} cannot register ${route}; it is reserved for ${owner}`);
          }
        }
        httpRoutes.set(key, mod.id); app[method.toLowerCase()](route, ...handlers);
      } }),
      websocket: Object.freeze({ route(route, handler) {
        if (typeof route !== "string" || !route.startsWith("/") || route.includes("?") || typeof handler !== "function") {
          throw new Error(`Module ${mod.id} registered invalid WebSocket route: ${route}`);
        }
        if (wsRoutes.has(route)) throw new Error(`Duplicate WebSocket route ${route}: ${wsRoutes.get(route)} and ${mod.id}`);
        if (mod.prefix !== "/" && route !== mod.prefix && !route.startsWith(`${mod.prefix}/`)) throw new Error(`Module ${mod.id} cannot register WebSocket route outside ${mod.prefix}: ${route}`);
        for (const [prefix, owner] of owners) {
          if (owner !== mod.id && prefix !== "/" && (route === prefix || route.startsWith(`${prefix}/`))) {
            throw new Error(`Route ownership conflict: module ${mod.id} cannot register ${route}; it belongs to ${owner} (${prefix})`);
          }
        }
        for (const [reserved, owner] of reservedPrefixes) {
          if (owner !== mod.id && (route === reserved || route.startsWith(`${reserved}/`))) {
            throw new Error(`Route ownership conflict: module ${mod.id} cannot register ${route}; it is reserved for ${owner}`);
          }
        }
        wsRoutes.set(route, mod.id);
        registeredWebSockets.push(route);
        services.registerWebSocket(route, handler, mod.id);
      } }),
      health: Object.freeze({ register(handler) {
        if (typeof handler !== "function") throw new TypeError(`Module ${mod.id} health check must be a function`);
        const healthPath = mod.prefix === "/" ? `/${mod.id}/healthz` : `${mod.prefix}/healthz`;
        const key = `GET ${healthPath}`;
        if (httpRoutes.has(key)) throw new Error(`Duplicate HTTP route ${key}`);
        for (const [reserved, owner] of reservedPrefixes) {
          if (healthPath === reserved || healthPath.startsWith(`${reserved}/`) || reserved.startsWith(`${healthPath}/`)) {
            throw new Error(`Health route ${healthPath} conflicts with ${owner} route ${reserved}`);
          }
        }
        httpRoutes.set(key, mod.id);
        reservedPrefixes.set(healthPath, mod.id);
        app.get(healthPath, async (_req, res, next) => {
          try {
            const result = await handler();
            const healthy = result === undefined || result === true || result?.healthy === true;
            const details = result && typeof result === "object" ? result : {};
            res.status(healthy ? 200 : 503).json({ ...details, app: mod.id, healthy });
          } catch (error) {
            next(error);
          }
        });
      } }),
    });
    const cleanup = await mod.setup(context);
    if (cleanup !== undefined && typeof cleanup !== "function") throw new Error(`Module ${mod.id} setup must return a cleanup function or nothing`);
    if (cleanup) cleanups.push(cleanup);
    for (const route of registeredWebSockets) services.activateWebSocket?.(route);
  }
  app.use((err, _req, res, _next) => {
    res.status(500).type("text/plain").send("Internal Server Error");
  });
  app.use((_req, res) => res.status(404).type("text/plain").send("Not Found"));
  return {
    app,
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}
