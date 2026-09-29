import { DurableObject } from "cloudflare:workers";

const TTL_MS = 15 * 60 * 1000; // waiting room lives 15 minutes
const MAX_MSG = 65536;
const TYPES = new Set(["offer", "answer", "ice"]);

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const role = new URL(request.url).searchParams.get("role");
    if (role !== "sender" && role !== "receiver") {
      return new Response("Bad role", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());

    let problem = null;
    if (this.ctx.getWebSockets(role).length > 0) problem = role === "sender" ? "taken" : "full";
    else if (role === "receiver" && this.ctx.getWebSockets("sender").length === 0) problem = "not_found";

    if (problem) {
      this.ctx.acceptWebSocket(server, ["rejected"]);
      server.send(JSON.stringify({ type: "error", code: problem }));
      server.close(1008, problem);
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.send(JSON.stringify({ type: "ok" }));
    if (role === "sender") {
      await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
    } else {
      for (const s of this.ctx.getWebSockets("sender")) s.send(JSON.stringify({ type: "peer-joined" }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > MAX_MSG) return ws.close(1009, "Message too large");
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || !TYPES.has(m.type)) return;
    const role = this.ctx.getTags(ws)[0];
    if (m.type === "offer" && role !== "sender") return;
    if (m.type === "answer" && role !== "receiver") return;
    if (m.type === "ice") {
      if (!m.candidate || typeof m.candidate !== "object") return;
    } else if (!m.sdp || typeof m.sdp.sdp !== "string" || typeof m.sdp.type !== "string") {
      return;
    }
    const other = role === "sender" ? "receiver" : "sender";
    const out = JSON.stringify({ type: m.type, sdp: m.sdp, candidate: m.candidate });
    for (const s of this.ctx.getWebSockets(other)) s.send(out);
  }

  webSocketClose(ws) { this.#left(ws); }
  webSocketError(ws) { this.#left(ws); }

  #left(ws) {
    const role = this.ctx.getTags(ws)[0];
    try { ws.close(1000, "bye"); } catch {}
    if (role !== "sender" && role !== "receiver") return;
    const other = role === "sender" ? "receiver" : "sender";
    for (const s of this.ctx.getWebSockets(other)) {
      try {
        s.send(JSON.stringify({ type: "peer-left" }));
        if (role === "sender") s.close(1000, "sender left");
      } catch {}
    }
  }

  async alarm() {
    for (const s of this.ctx.getWebSockets()) { try { s.close(1000, "Room expired"); } catch {} }
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const origin = request.headers.get("Origin");
      if (origin) {
        let host = "";
        try { host = new URL(origin).host; } catch {}
        if (host !== url.host) return new Response("Forbidden", { status: 403 });
      }
      const code = url.searchParams.get("code") || "";
      if (!/^\d{6}$/.test(code)) return new Response("Invalid room code", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
