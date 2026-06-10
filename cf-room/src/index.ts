/**
 * agent-tmux-room — Cloudflare Worker stateless router (~50 lines)
 * Auth: Bearer token per team stored as Worker secret ROOM_TOKEN_<TEAM>
 * Routes: POST/GET /room/:team/{post,read,watch,status,member/add} → RoomDO
 */

import { RoomDO } from "./room-do";
export { RoomDO };

interface Env {
  ROOM: DurableObjectNamespace;
  [key: string]: unknown; // ROOM_TOKEN_<TEAM> secrets
}

const TEAM_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ROUTE_RE = /^\/room\/([^/]+)\/(.+)$/;

function err(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = ROUTE_RE.exec(url.pathname);
    if (!m) return err(404, "not_found");

    const team = m[1];
    const subpath = m[2]; // e.g. "post", "read", "watch", "status", "member/add"

    // Team name validation — reject path traversal and invalid chars
    if (!TEAM_RE.test(team) || team.includes("..")) return err(400, "invalid_team");

    // Bearer auth — token may arrive in Authorization header or ?token= (WS clients)
    const authHeader = request.headers.get("Authorization") ?? "";
    const tokenFromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const tokenFromQuery = url.searchParams.get("token");
    const provided = tokenFromHeader ?? tokenFromQuery ?? "";

    const secretKey = `ROOM_TOKEN_${team.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const expected = (env[secretKey] as string | undefined) ?? "";
    if (!expected || provided !== expected) return err(403, "auth_failed");

    // WebSocket upgrade — pass through to DO /watch
    const isWS = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (isWS && subpath !== "watch") return err(400, "ws_only_on_watch");

    // Valid subpaths
    const allowed = new Set(["post", "read", "watch", "status", "member/add"]);
    if (!allowed.has(subpath)) return err(404, "not_found");

    // Forward to RoomDO
    const stub = env.ROOM.get(env.ROOM.idFromName(team));
    const doUrl = new URL(request.url);
    doUrl.pathname = `/${subpath}`;
    return stub.fetch(new Request(doUrl.toString(), request));
  },
};
