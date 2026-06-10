/**
 * agent-tmux-room — Cloudflare Worker stateless router (~60 lines)
 * Auth: Bearer token per team stored as Worker secret ROOM_TOKEN_<TEAM>
 * Routes: POST/GET /room/:team/{post,read,watch,status,member/add} → RoomDO
 *
 * Security notes:
 * - WebSocket auth uses Sec-WebSocket-Protocol: bearer.<token> (URLs are logged; never put tokens in query strings)
 * - Token comparison uses constant-time crypto.subtle HMAC-SHA-256 digest to prevent timing attacks
 */

import { RoomDO } from "./room-do";
export { RoomDO };

interface Env {
  ROOM: DurableObjectNamespace;
  [key: string]: unknown; // ROOM_TOKEN_<TEAM> secrets
}

const TEAM_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ROUTE_RE = /^\/room\/([^/]+)\/(.+)$/;
const ENC = new TextEncoder();

function err(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string equality via HMAC-SHA-256 digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, ENC.encode(a)),
    crypto.subtle.sign("HMAC", key, ENC.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
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

    const isWS = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    // Bearer auth:
    // - Non-WS routes: Authorization: Bearer <token>
    // - WS upgrade:    Sec-WebSocket-Protocol: bearer.<token>
    //   (URL query strings are written to access logs; tokens must never appear there)
    let provided = "";
    if (isWS) {
      const proto = request.headers.get("Sec-WebSocket-Protocol") ?? "";
      const match = /(?:^|,\s*)bearer\.(\S+?)(?:,|$)/.exec(proto);
      provided = match ? match[1] : "";
    } else {
      const authHeader = request.headers.get("Authorization") ?? "";
      provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    }

    const secretKey = `ROOM_TOKEN_${team.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const expected = (env[secretKey] as string | undefined) ?? "";
    if (!expected || !(await safeEqual(provided, expected))) return err(403, "auth_failed");

    if (isWS && subpath !== "watch") return err(400, "ws_only_on_watch");

    // Valid subpaths
    const allowed = new Set(["post", "read", "watch", "status", "member/add"]);
    if (!allowed.has(subpath)) return err(404, "not_found");

    // Forward to RoomDO; echo negotiated protocol in 101 response (required by WS spec)
    const stub = env.ROOM.get(env.ROOM.idFromName(team));
    const doUrl = new URL(request.url);
    doUrl.pathname = `/${subpath}`;
    // Strip Sec-WebSocket-Protocol so the DO doesn't see the raw bearer token;
    // the DO response will be patched to echo back the accepted protocol header.
    const forwardHeaders = new Headers(request.headers);
    const rawProto = request.headers.get("Sec-WebSocket-Protocol") ?? "";
    if (isWS && rawProto) {
      // Pass only non-bearer protocol tokens to the DO (e.g. app-level sub-protocols)
      const filtered = rawProto
        .split(",")
        .map((p) => p.trim())
        .filter((p) => !p.startsWith("bearer."))
        .join(", ");
      if (filtered) {
        forwardHeaders.set("Sec-WebSocket-Protocol", filtered);
      } else {
        forwardHeaders.delete("Sec-WebSocket-Protocol");
      }
    }
    const doReq = new Request(doUrl.toString(), { ...request, headers: forwardHeaders });
    const doResp = await stub.fetch(doReq);

    // Echo back the accepted Sec-WebSocket-Protocol so browsers complete the WS handshake
    if (isWS && doResp.status === 101) {
      const respHeaders = new Headers(doResp.headers);
      respHeaders.set("Sec-WebSocket-Protocol", "bearer." + provided.split(".")[0]);
      // actually echo the full token prefix negotiated; spec requires echoing one of the offered values
      const offered = rawProto
        .split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith("bearer."));
      if (offered) respHeaders.set("Sec-WebSocket-Protocol", offered);
      return new Response(doResp.body, { status: doResp.status, statusText: doResp.statusText, headers: respHeaders });
    }
    return doResp;
  },
};
