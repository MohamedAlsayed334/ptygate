import crypto from "node:crypto";
import { normalizeIp } from "./ip_policy.js";

/**
 * Decode percent-encoded components safely without throwing URIError.
 * Malformed sequences like "%E0%A4%A" will return the raw value instead of crashing.
 */
export function safeDecodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse Cookie header safely.
 * Returns an object map of key-value pairs.
 */
export function parseCookies(req) {
  const out = {};
  const header = req.headers?.cookie;
  if (!header) return out;

  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    out[name] = safeDecodeComponent(val);
  }
  return out;
}

/**
 * Constant-time comparison between given token and configured target token.
 * Prevents timing attacks.
 */
export function tokenMatches(given, targetToken) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(targetToken ?? ""));

  if (a.length !== b.length) {
    // Perform dummy comparison to keep timing uniform
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generate Set-Cookie header value conforming to Protocol v1 spec.
 * @param {string} sid
 * @param {number} maxAgeMs
 * @param {boolean} secure
 */
export function formatSessionCookie(sid, maxAgeMs, secure = false) {
  const maxAgeSec = Math.max(0, Math.floor(maxAgeMs / 1000));
  const bits = [
    `wt_session=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) {
    bits.push("Secure");
  }
  return bits.join("; ");
}

/**
 * In-memory Session Store and Brute-force Lockout Manager.
 */
export class AuthManager {
  constructor(config) {
    this.config = config;
    /** @type {Map<string, {created: number, seen: number}>} */
    this.sessions = new Map();
    /** @type {Map<string, {count: number, until: number}>} */
    this.loginFails = new Map();

    this.maxFails = 10;
    this.lockoutMs = 15 * 60 * 1000; // 15 mins

    // Cleanup expired sessions every 10 minutes
    this.cleanupTimer = setInterval(() => {
      this.purgeExpiredSessions();
    }, 10 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  purgeExpiredSessions() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.seen > this.config.sessionTtlMs) {
        this.sessions.delete(sid);
      }
    }
  }

  createSession() {
    // Generate at least 32 random bytes (64 hex characters)
    const sid = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    this.sessions.set(sid, { created: now, seen: now });
    return sid;
  }

  getSession(sid) {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.seen > this.config.sessionTtlMs) {
      this.sessions.delete(sid);
      return null;
    }
    s.seen = Date.now();
    return s;
  }

  deleteSession(sid) {
    if (sid) {
      this.sessions.delete(sid);
    }
  }

  isLockedOut(rawIp) {
    const ip = normalizeIp(rawIp) || "unknown";
    const entry = this.loginFails.get(ip);
    if (!entry) return false;
    const now = Date.now();
    if (entry.until && entry.until > now) return true;
    if (entry.until && entry.until <= now) {
      this.loginFails.delete(ip);
    }
    return false;
  }

  recordFail(rawIp) {
    const ip = normalizeIp(rawIp) || "unknown";
    const entry = this.loginFails.get(ip) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= this.maxFails) {
      entry.until = Date.now() + this.lockoutMs;
    }
    this.loginFails.set(ip, entry);
  }

  recordSuccess(rawIp) {
    const ip = normalizeIp(rawIp) || "unknown";
    this.loginFails.delete(ip);
  }

  verifyToken(given) {
    return tokenMatches(given, this.config.token);
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}
