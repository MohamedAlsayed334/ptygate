import { WebSocketServer } from "ws";
import { isIpAllowed, normalizeIp } from "./ip_policy.js";
import { parseCookies } from "./auth.js";
import { logger } from "./logger.js";

/**
 * Reject WebSocket upgrade attempt with an explicit HTTP response and destroy socket.
 */
function rejectUpgrade(socket, code, text, headers = {}) {
  try {
    let resp = `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      resp += `${k}: ${v}\r\n`;
    }
    resp += `\r\n${text}\n`;
    socket.write(resp);
  } catch {
    /* socket already closed or destroyed */
  }
  socket.destroy();
}

/**
 * Configure and attach WebSocket handling to HTTP server.
 * @param {import("node:http").Server} server
 * @param {object} config
 * @param {import("./auth.js").AuthManager} authManager
 * @param {import("./pty.js").PtyManager} ptyManager
 */
export function setupWebSocket(server, config, authManager, ptyManager) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxInputBytes,
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      logger.log(`[ws] upgrade exception: ${err?.message || err}`);
      rejectUpgrade(socket, 400, "Bad Request");
    }
  });

  function handleUpgrade(req, socket, head) {
    // 1. Basic HTTP / WebSocket handshake format verification
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      return rejectUpgrade(socket, 400, "Bad Request: Missing Host header");
    }

    let url;
    try {
      url = new URL(req.url, `http://${hostHeader}`);
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request: Malformed URL");
    }

    if (url.pathname !== "/ws") {
      return rejectUpgrade(socket, 404, "Not Found");
    }

    const upgradeHeader = req.headers.upgrade;
    const connectionHeader = req.headers.connection;
    const secWsKey = req.headers["sec-websocket-key"];
    const secWsVersion = req.headers["sec-websocket-version"];

    if (
      !upgradeHeader ||
      upgradeHeader.toLowerCase() !== "websocket" ||
      !connectionHeader ||
      !connectionHeader.toLowerCase().includes("upgrade") ||
      !secWsKey ||
      secWsVersion !== "13"
    ) {
      return rejectUpgrade(socket, 400, "Bad Request: Invalid WebSocket Handshake");
    }

    // 2. IP Policy check -> 403
    if (!isIpAllowed(req.socket.remoteAddress, config)) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }

    // 3. Origin check (CSWSH prevention) -> 403
    const origin = req.headers.origin;
    if (origin) {
      if (origin === "null") {
        return rejectUpgrade(socket, 403, "Forbidden: Invalid Origin");
      }
      try {
        const originUrl = new URL(origin);
        if (originUrl.host.toLowerCase() !== hostHeader.toLowerCase()) {
          return rejectUpgrade(socket, 403, "Forbidden: Origin Mismatch");
        }
      } catch {
        return rejectUpgrade(socket, 403, "Forbidden: Invalid Origin");
      }
    }

    // 4. Auth check -> 401
    const cookies = parseCookies(req);
    const sid = cookies.wt_session;
    if (!sid || !authManager.getSession(sid)) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    // 5. Capacity check -> 429
    const existingPty = ptyManager.getPtyForSession(sid);
    if (!existingPty && !ptyManager.hasCapacity()) {
      return rejectUpgrade(socket, 429, "Too Many Requests: Max PTY capacity reached");
    }

    // 6. Subprotocol check -> 426
    const rawProtocols = req.headers["sec-websocket-protocol"] || "";
    const clientProtocols = rawProtocols
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const matchedProtocol = clientProtocols.includes("ptygate.v1") ? "ptygate.v1" : null;

    if (!matchedProtocol) {
      return rejectUpgrade(socket, 426, "Upgrade Required", {
        "Sec-WebSocket-Protocol": "ptygate.v1",
      });
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, sid, "ptygate.v1");
    });
  }

  wss.on("connection", (ws, req, sid, subprotocol) => {
    const ip = normalizeIp(req.socket.remoteAddress);
    ws.isAlive = true;
    ws.missedPongs = 0;

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.missedPongs = 0;
    });

    let ptyInstance = ptyManager.getPtyForSession(sid);
    const isResumed = Boolean(ptyInstance);

    if (!ptyInstance) {
      try {
        ptyInstance = ptyManager.createPty(sid, 80, 24);
      } catch (err) {
        logger.log(`[pty] spawn error: ${err?.message || err}`);
      }
    }

    if (!ptyInstance) {
      logger.log(`[pty] failed to acquire pty for session ${sid.slice(0, 8)}`);
      try {
        ws.close(1011, "failed to start shell");
      } catch {
        /* ignore */
      }
      return;
    }

    logger.log(`[pty] ${isResumed ? "reattached" : "open"} pid=${ptyInstance.pid} from ${ip}`);

    // Send hello frame FIRST
    const helloFrame = {
      type: "hello",
      protocol: 1,
      impl: "node",
      session: sid,
      cols: ptyInstance.cols,
      rows: ptyInstance.rows,
      resumed: isResumed,
    };
    ws.send(JSON.stringify(helloFrame));

    // If resumed, replay scrollback buffer
    if (isResumed) {
      const replay = ptyInstance.getReplayString();
      if (replay.length > 0) {
        ws.send(JSON.stringify({ type: "output", data: replay }));
      }
    }

    // Attach active ws to pty instance
    ptyInstance.attach(ws);

    // Handle incoming client messages
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        // Malformed JSON must not crash server
        return;
      }

      if (msg?.type === "input" && typeof msg.data === "string") {
        ptyInstance.write(msg.data);
      } else if (msg?.type === "resize") {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        ptyInstance.resize(cols, rows);
      } else if (msg?.type === "detach") {
        ptyInstance.detach();
        try {
          ws.close(1000, "detached");
        } catch {
          /* ignore */
        }
      }
    });

    let cleaned = false;
    const onDisconnect = () => {
      if (cleaned) return;
      cleaned = true;
      if (ptyInstance.activeWs === ws) {
        ptyInstance.detach();
      }
    };

    ws.on("close", onDisconnect);
    ws.on("error", onDisconnect);
  });

  // Heartbeat ping interval: drop connections missing 2 consecutive pongs
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missedPongs >= 2) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }

      ws.missedPongs = (ws.missedPongs || 0) + 1;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  heartbeatTimer.unref?.();

  return {
    wss,
    close: () => {
      clearInterval(heartbeatTimer);
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
