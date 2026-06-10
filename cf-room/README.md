# agent-tmux-room — Cloudflare Worker + Durable Object

Phase 2b backend for `agent-tmux room` — shared state for machines that cannot directly SSH to each other (NAT, heterogeneous clouds).

## Deploy

```sh
cd cf-room

# 1. Install dependencies
npm install

# 2. Set per-team bearer token (repeat for each team)
#    Token should be 32+ random bytes, base64url-encoded.
#    Generate: openssl rand -base64 32 | tr -d '=\n' | tr '+/' '-_'
wrangler secret put ROOM_TOKEN_MYTEAM

# 3. Deploy
wrangler deploy
```

The worker is deployed to `https://agent-tmux-room.<your-subdomain>.workers.dev`.

## Shell client usage

Set `AGENT_TMUX_ROOM_TOKEN` to the team token, then pass `--hub https://...` to `agent-tmux room`:

```sh
export AGENT_TMUX_ROOM_TOKEN=<token>
agent-tmux room post myteam --from w1 --msg "done" --hub https://agent-tmux-room.<subdomain>.workers.dev
agent-tmux room read myteam --since 0 --hub https://...
agent-tmux room status myteam --hub https://...
```

## Quota

Default: 200 messages per member. Override via `wrangler.toml` environment binding `ROOM_QUOTA`.

## Auth note

One bearer token per team. All agents sharing a team use the same token. Token is opaque; member identity is in the `from` field of each message. Token distribution is out-of-band (same as SSH key in Phase 2a).

No JWT, no OAuth, no Cloudflare Access — intentionally minimal.
