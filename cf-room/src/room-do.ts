/**
 * RoomDO — Durable Object with SQLite storage and WebSocket hibernation fan-out
 * Schema: §4.2  RPC surface: §4.3  WS: §6.3  Quota: §9
 */

interface Env {
  ROOM_QUOTA?: string;
}

interface MsgRow extends Record<string, SqlStorageValue> {
  seq: number;
  ts: string;
  from_: string;
  topic: string;
  msg: string;
}

const MEMBER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TOPIC_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_QUOTA = 200;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class RoomDO implements DurableObject {
  private state: DurableObjectState;
  private sql: SqlStorage;
  private quota: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.quota = parseInt(env.ROOM_QUOTA ?? "", 10) || DEFAULT_QUOTA;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts    TEXT    NOT NULL,
        from_ TEXT    NOT NULL,
        topic TEXT    NOT NULL DEFAULT 'general',
        msg   TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        name  TEXT PRIMARY KEY
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, ""); // strip leading slash

    if (path === "post" && request.method === "POST") return this.handlePost(request);
    if (path === "read" && request.method === "GET") return this.handleRead(url);
    if (path === "watch" && request.method === "GET") return this.handleWatch(request, url);
    if (path === "status" && request.method === "GET") return this.handleStatus();
    if (path === "member/add" && request.method === "POST") return this.handleMemberAdd(request);

    return this.jsonResponse(404, { error: "not_found" });
  }

  // ── /post ──────────────────────────────────────────────────────────────────

  private async handlePost(request: Request): Promise<Response> {
    let body: { from?: unknown; topic?: unknown; msg?: unknown };
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse(400, { error: "invalid_json" });
    }

    const from = String(body.from ?? "");
    const topic = String(body.topic ?? "general");
    const msg = String(body.msg ?? "");

    if (!MEMBER_RE.test(from)) return this.jsonResponse(400, { error: "invalid_from" });
    if (!TOPIC_RE.test(topic)) return this.jsonResponse(400, { error: "invalid_topic" });
    if (!msg) return this.jsonResponse(400, { error: "empty_msg" });

    // Quota check
    const countResult = this.sql.exec<{ cnt: number }>(
      `SELECT count(*) AS cnt FROM messages WHERE from_ = ?`, from
    );
    const cnt = countResult.one()?.cnt ?? 0;
    if (cnt >= this.quota) return this.jsonResponse(429, { error: "quota_exceeded" });

    const ts = new Date().toISOString();
    const insert = this.sql.exec<{ seq: number }>(
      `INSERT INTO messages (ts, from_, topic, msg) VALUES (?, ?, ?, ?) RETURNING seq`,
      ts, from, topic, msg
    );
    const seq = insert.one()!.seq;

    // Fan-out to hibernated WebSocket subscribers
    this.fanOut({ seq, ts, from, topic, msg });

    return this.jsonResponse(200, { seq, ts });
  }

  // ── /read ──────────────────────────────────────────────────────────────────

  private handleRead(url: URL): Response {
    const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
    const topic = url.searchParams.get("topic") ?? null;
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      MAX_LIMIT
    );

    let rows: MsgRow[];
    if (topic) {
      rows = Array.from(this.sql.exec<MsgRow>(
        `SELECT seq, ts, from_, topic, msg FROM messages WHERE seq > ? AND topic = ? ORDER BY seq LIMIT ?`,
        since, topic, limit
      ));
    } else {
      rows = Array.from(this.sql.exec<MsgRow>(
        `SELECT seq, ts, from_, topic, msg FROM messages WHERE seq > ? ORDER BY seq LIMIT ?`,
        since, limit
      ));
    }

    const messages = rows.map(r => ({
      seq: r.seq, ts: r.ts, from: r.from_, topic: r.topic, msg: r.msg
    }));
    return this.jsonResponse(200, { messages });
  }

  // ── /watch (WebSocket hibernation) ─────────────────────────────────────────

  private handleWatch(request: Request, url: URL): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return this.jsonResponse(426, { error: "upgrade_required" });
    }

    const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
    const topic = url.searchParams.get("topic") ?? null;
    const member = url.searchParams.get("member") ?? "unknown";

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server, [
      JSON.stringify({ since, topic, member })
    ]);

    // Replay missed messages immediately
    let missed: MsgRow[];
    if (topic) {
      missed = Array.from(this.sql.exec<MsgRow>(
        `SELECT seq, ts, from_, topic, msg FROM messages WHERE seq > ? AND topic = ? ORDER BY seq`,
        since, topic
      ));
    } else {
      missed = Array.from(this.sql.exec<MsgRow>(
        `SELECT seq, ts, from_, topic, msg FROM messages WHERE seq > ? ORDER BY seq`,
        since
      ));
    }
    for (const r of missed) {
      server.send(JSON.stringify({
        t: "msg", seq: r.seq, ts: r.ts, from: r.from_, topic: r.topic, msg: r.msg
      }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // WebSocket message handler (hibernation callbacks)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const frame = JSON.parse(typeof message === "string" ? message : "{}");
      if (frame.t === "pong") return; // keepalive ack — no action needed
    } catch {
      // ignore parse errors from client
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {
    // hibernation handles cleanup automatically
  }

  // ── /status ────────────────────────────────────────────────────────────────

  private handleStatus(): Response {
    const memberCount = (this.sql.exec<{ cnt: number }>(`SELECT count(*) AS cnt FROM members`).one()?.cnt ?? 0);
    const messageCount = (this.sql.exec<{ cnt: number }>(`SELECT count(*) AS cnt FROM messages`).one()?.cnt ?? 0);
    const cursors = Array.from(this.sql.exec<{ from_: string; max_seq: number }>(
      `SELECT from_, max(seq) AS max_seq FROM messages GROUP BY from_`
    )).map(r => ({ member: r.from_, last_seq: r.max_seq }));
    return this.jsonResponse(200, { member_count: memberCount, message_count: messageCount, cursors });
  }

  // ── /member/add ────────────────────────────────────────────────────────────

  private async handleMemberAdd(request: Request): Promise<Response> {
    let body: { name?: unknown };
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse(400, { error: "invalid_json" });
    }
    const name = String(body.name ?? "");
    if (!MEMBER_RE.test(name)) return this.jsonResponse(400, { error: "invalid_name" });
    this.sql.exec(`INSERT OR IGNORE INTO members (name) VALUES (?)`, name);
    return this.jsonResponse(200, { ok: true });
  }

  // ── Fan-out ────────────────────────────────────────────────────────────────

  private fanOut(msg: { seq: number; ts: string; from: string; topic: string; msg: string }): void {
    const sockets: WebSocket[] = this.state.getWebSockets();
    const frame = JSON.stringify({ t: "msg", ...msg });
    for (const ws of sockets) {
      try {
        // Filter by topic subscription stored in ws tags
        const tags: string[] = this.state.getTags(ws);
        const meta = tags[0] ? JSON.parse(tags[0]) : {};
        if (meta.topic && meta.topic !== msg.topic) continue;
        ws.send(frame);
      } catch {
        // ignore closed sockets
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
