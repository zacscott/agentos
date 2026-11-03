// MCP server — official @modelcontextprotocol/sdk, stateless Streamable HTTP.
//
// Two tools, deliberately minimal:
//   brief — return the entry document and the documents available to read.
//   read  — return the documents an agent asks for, in one call.
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

Otherwise, call brief before project work. It returns the operating manual plus the documents it can read. Call read once with every document you need, rather than one call per file. Do not invent document ids; brief lists them.`;
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
    { name: "agentos", version: "2.1.0" },
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
      description:
        "Return the documents you name, in one call. Pass every reference and skill you need together rather than calling once per file. Each entry is identified by the path brief listed; an id that does not exist fails only its own entry, so the rest of the batch still comes back.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Document ids from brief, e.g. [\"skills/voice.md\", \"reference/principles/code-style.md\"].")
      }
    },
    async ({ ids }) => asResult(await readContent(env, { ids }))
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
