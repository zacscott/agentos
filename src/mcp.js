// MCP server — official @modelcontextprotocol/sdk, stateless Streamable HTTP.
//
// Two tools, deliberately minimal:
//   brief — return the entry document and the documents available to read.
//   read  — return one document by id.
//
// The entry document is the behaviour specification. Tool descriptions tell
// clients what to call; the document itself tells agents when and why to use
// those tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { briefText, readContent } from "./content.js";

export function instructions() {
  return `This server serves a private operating manual for AI agents. It contains rules, reference material and skills.

If the operating rules are already in your context, do not call brief again.

Otherwise, call brief before project work. It returns the operating manual plus the documents it can read. Call read to load only the documents you actually need. Do not invent document ids; brief lists them.`;
}

const asResult = body => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  isError: body.ok === false
});

const asText = body => ({
  content: [{ type: "text", text: body.content || JSON.stringify(body) }],
  isError: body.ok === false
});

function buildServer(env) {
  const server = new McpServer(
    { name: "agentos", version: "2.0.0" },
    { instructions: instructions() }
  );

  server.registerTool(
    "brief",
    {
      description:
        "Return the operating manual and the documents available to read. Call before project work unless the rules are already in your context.",
      inputSchema: {}
    },
    async () => asText(await briefText(env))
  );

  server.registerTool(
    "read",
    {
      description: "Return one document listed by brief. The id must be one of the listed reference/ or skills/ Markdown paths.",
      inputSchema: {
        id: z.string().describe("The document id returned by brief, e.g. skills/voice.md.")
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
