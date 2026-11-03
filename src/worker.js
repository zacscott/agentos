// agentos — a private, read-only operating manual for AI agents over MCP.
//
//   POST /mcp      MCP server (brief, search, read)
//   GET /health    unauthenticated liveness check
//
// The bucket is a mirror of a Markdown repository, with AGENTS.md at the root
// and two kinds of content:
//
//   reference/principles/...
//   reference/languages/...
//   skills/...
//
// The bucket is not served directly. This Worker is the only read path; /mcp
// requires a bearer token and the tool surface is read-only.
//
// Auth: every route except /health requires `Authorization: Bearer <token>`.
// Each client gets its OWN Worker secret named API_KEY_<CLIENT> — nothing
// token-related lives in wrangler.toml, and one key can be added, rotated or
// revoked without touching the others.

import { handleMcp } from "./mcp.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });

// Scan env for API_KEY_* secrets. Secrets arrive on env like any other
// binding, so Object.entries picks them up — no registry of valid clients
// needs to exist anywhere in code or config. Exact string equality on long
// random tokens; the presented token is never logged.
function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  if (!presented) return false;

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("API_KEY_")) continue;
    if (typeof value === "string" && value.length >= 16 && value === presented) {
      return true;
    }
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, service: "agentos" });

      if (!authenticate(request, env)) return json({ ok: false, error: "unauthorised" }, 401);

      if (url.pathname !== "/mcp") return json({ ok: false, error: "not found" }, 404);
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

      return handleMcp(request, env);
    } catch (err) {
      return json({ ok: false, error: err.message || String(err) }, 500);
    }
  }
};
