// MCP server — official @modelcontextprotocol/sdk, stateless Streamable HTTP.
//
// Three tools, deliberately small:
//   brief  — return the entry document unchanged.
//   search — find matching documents, or the entire catalogue.
//   read   — return one document by id.
//
// The entry document is the behaviour specification. Tool descriptions tell
// clients what to call; the document itself tells agents when and why to use
// those tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { KINDS, searchContent, readContent } from "./content.js";

export function instructions() {
  return `This server serves a private operating manual for AI agents. It contains rules, reference material and skills.

If the operating rules are already in your context, do not call brief again.

Otherwise, call brief before project work. Then call search when you need to find a relevant document, and call read to load it before acting on it. Do not invent document ids; search returns them. Read only what you need.`;
}

const asResult = body => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  isError: body.ok === false
});

const asText = (body) => ({
  content: [{ type: "text", text: body.content || "" }],
  isError: body.ok === false
});

async function brief(env) {
  const object = await env.CONTENT.get(env.ENTRY_FILE || "AGENTS.md");
  if (!object) {
    return { ok: false, error: `content bucket is missing ${env.ENTRY_FILE || "AGENTS.md"}` };
  }
  return { ok: true, id: env.ENTRY_FILE || "AGENTS.md", content: await object.text() };
}

function buildServer(env) {
  const server = new McpServer(
    { name: "agentos", version: "1.0.0" },
    { instructions: instructions() }
  );

  server.registerTool(
    "brief",
    {
      description:
        "Return the operating manual. Call before project work unless the rules are already in your context.",
      inputSchema: {}
    },
    async () => asText(await brief(env))
  );

  server.registerTool(
    "search",
    {
      description: `Search the reference and skills documents. Returns up to 10 matching documents by default, ordered by relevance, including a subject and a short description. Omit the query to browse the catalogue.`,
      inputSchema: {
        query: z.string().optional().describe("Words that must appear across the path, title, description and body. Omit to browse."),
        kind: z.enum(KINDS).optional().describe("Filter to reference or skills documents."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 10).")
      }
    },
    async ({ query, kind, limit }) => asResult(await searchContent(env, { query, kind, limit }))
  );

  server.registerTool(
    "read",
    {
      description: "Return one document returned by search. The id must match a known reference/ or skills/ Markdown path.",
      inputSchema: {
        id: z.string().describe("The document id returned by search, e.g. skills/voice.md.")
      }
    },
    async ({ id }) => asResult(await readContent(env, id))
  );

  return server;
}

export async function handleMcp(request, env) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await buildServer(env).connect(transport);
  return transport.handleRequest(request);
}
