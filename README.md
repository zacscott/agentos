# agentos

Serve a private Markdown operating manual to AI agents over MCP.

`agentos` reads a bucket containing a document at `AGENTS.md`, reference
documents under `reference/`, and procedures under `skills/`. It exposes two
read-only tools:

| Tool | Arguments | |
|---|---|---|
| `brief` | — | Return the entry document, unchanged, followed by a catalogue of readable documents. |
| `read` | `id` | Return one document by its repository path. |

The bucket is read fresh on every request, so edits take effect immediately.
There is no index, cache or manifest to maintain.

## Why this layout

Canonical repository content stays the source of truth. The bucket is a
straight copy of it, so agents on any host can read the same material without
an installation step.

```text
AGENTS.md
reference/principles/code-design.md
reference/principles/engineering-judgement.md
reference/languages/php.md
skills/voice.md
skills/writing.md
```

`AGENTS.md` owns the behaviour — when to call each tool and which files to
load. The server only provides access.

## Tools

### `brief()`

Returns the configured entry document (default `AGENTS.md`) exactly as stored,
followed by each readable document grouped by kind, with its title and
description. This is a generated listing of what the bucket contains, not a
rewritten version of the manual.

### `read()`

Returns the full Markdown file for one id listed in the catalogue. It can only
read files that exist under `reference/` or `skills/`.

## Deploy

1. Create the R2 bucket `agentos`.
2. Copy your Markdown repository into it, preserving paths:

   ```sh
   npx wrangler r2 bucket create agentos
   find AGENTS.md reference skills -type f -print0 |
     while IFS= read -r -d '' file; do
       npx wrangler r2 object put "agentos/$file" --file "$file"
     done
   ```

3. `npm install && npx wrangler deploy`
4. Add one Worker secret per client, named `API_KEY_<CLIENT>`, e.g.
   `API_KEY_CLAUDE`. The token is that client's bearer credential.
5. Point an MCP client at `https://<worker>/mcp`.

Enable the `workers.dev` URL for testing, or attach a custom domain.

## Local development

```sh
cp .dev.vars.example .dev.vars
npm run dev
```

`npm test` covers the catalogue and read behaviour against an in-memory
bucket.

## Configuration

- `ENTRY_FILE` — the document returned by `brief` (default: `AGENTS.md`)
- `API_KEY_*` — bearer secrets, one per client
- `CONTENT` — the R2 binding; create the bucket and keep the binding name

## Security

Every route except `/health` requires a bearer token. The service is
read-only and does not follow redirects or accept arbitrary paths.

The bucket remains private; agents never get direct public access to it.

All authenticated clients can read every document. If you need per-client
permission boundaries, treat them as separate deployments until the service
grows that feature.

## Notes

Frontmatter is used only to identify and catalogue documents, not to rewrite
their content or to control access. Every file returned by `brief` and
`read` is exactly as stored in the bucket.
