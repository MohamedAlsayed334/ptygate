/**
 * IP policy, validation, normalization, and CIDR matching.
 */

export function normalizeIp(raw) {
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

export function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function cidrMatch(ip, cidr) {
  const slash = cidr.indexOf("/");
  const base = slash === -1 ? cidr : cidr.slice(0, slash);
  const bits = slash === -1 ? 32 : Number(cidr.slice(slash + 1));
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export const PRIVATE_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local
  "100.64.0.0/10", // CGNAT (also Tailscale)
];

export function isPrivateIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  if (ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    // unique-local (fc00::/7) and link-local (fe80::/10)
    return /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
  }
  return PRIVATE_V4.some((c) => cidrMatch(ip, c));
}

/**
 * Checks whether an incoming client IP is permitted according to config policy.
 * @param {string} rawIp
 * @param {object} config
 * @returns {boolean}
 */
export function isIpAllowed(rawIp, config) {
  const ip = normalizeIp(rawIp);
  if (!ip) return false;

  // In 'any' mode, all IPs are permitted
  if (config.ipMode === "any") {
    return true;
  }

  // If explicit ALLOWED_IPS is configured, check against it
  if (config.allowedIps && config.allowedIps.length > 0) {
    return config.allowedIps.some((entry) => {
      if (entry.includes("/")) {
        return cidrMatch(ip, entry);
      }
      return normalizeIp(entry) === ip;
    });
  }

  // Otherwise, default allowlist mode allows private/local IP ranges
  return isPrivateIp(ip);
}
