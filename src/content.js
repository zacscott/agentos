// Content access for agentos. The bucket is a mirror of a Markdown repository:
//
//   AGENTS.md
//   reference/principles/code-design.md
//   reference/languages/php.md
//   skills/voice.md
//
// There is deliberately no database, manifest or search index: the corpus is
// small and it changes infrequently, so every request reads the current
// content. Edits in the bucket are visible immediately. The two kinds are
// directories; ids are the object keys.

export const KINDS = Object.freeze(["reference", "skills"]);

const PATH = /^(reference|skills)\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\.md$/;
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;
const FRONT_VALUE = /^([a-z_][a-z0-9_-]*):\s*(.*)$/;
const HEADING = /^#\s+(.+?)\s*$/m;

/** Parse the small YAML-like frontmatter used by the content files. */
export function contentMeta(text) {
  const frontMatter = text.match(FRONT_MATTER)?.[1] || "";
  const read = (field) =>
    frontMatter
      .split("\n")
      .map(line => line.match(FRONT_VALUE))
      .filter(match => match && match[1].toLowerCase() === field)
      .map(match => match[2].trim())[0] || "";

  const name = read("name");
  const description = read("description");
  const title = text.match(HEADING)?.[1]?.trim() || name;
  return { name, description, title };
}

/** Strip frontmatter because callers need the useful content, not the markers. */
export function contentBody(text) {
  return text.replace(FRONT_MATTER, "");
}

/** Every content object key for one or both kinds, in stable order. */
export async function listContent(env, kind) {
  const wanted = kind ? [kind] : [...KINDS];
  const keys = [];

  for (const name of wanted) {
    let cursor;
    do {
      const listed = await env.CONTENT.list({ prefix: `${name}/`, cursor, limit: 1000 });
      for (const object of listed.objects) {
        if (PATH.test(object.key)) keys.push(object.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  return keys.sort();
}

function tokens(query) {
  return String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

/** Which file, if any, an id refers to. Only exact known keys are allowed. */
export async function knownContent(env) {
  return new Set(await listContent(env));
}

function snippet(text, queryTokens) {
  const lines = contentBody(text).split("\n");
  if (!queryTokens.length) return lines.find(line => line.trim())?.trim() || "";

  const hit = lines.find(line => {
    const lower = line.toLowerCase();
    return queryTokens.some(token => lower.includes(token));
  });

  return String(hit || lines.find(line => line.trim()) || "").trim();
}

function scoreFile(id, meta, body, queryTokens) {
  if (!queryTokens.length) return 0;

  const path = id.toLowerCase();
  const name = meta.name.toLowerCase();
  const description = meta.description.toLowerCase();
  const text = body.toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    const inPath = path.includes(token);
    const inDescription = description.includes(token);
    const inName = name.includes(token);
    const inText = text.includes(token);
    if (!inPath && !inDescription && !inName && !inText) return null;

    if (inPath) score += 16;
    if (inName) score += 12;
    if (inDescription) score += 8;
    if (inText) score += 2;
  }
  return score;
}

function number(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Search all content for a keyword. Returns full metadata for each match.
 * With no query, this is the lightweight index: the whole catalogue.
 */
export async function searchContent(env, { query = "", kind, limit } = {}) {
  if (kind && !KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of: ${KINDS.join(", ")}` };
  }

  const max = Math.min(Math.max(number(limit, number(env.SEARCH_LIMIT, 10)), 1), 50);
  const queryTokens = tokens(query);
  const keys = await listContent(env, kind);
  const objects = await Promise.all(keys.map(key => env.CONTENT.get(key)));
  const candidates = [];

  for (let i = 0; i < keys.length; i++) {
    const text = objects[i] ? await objects[i].text() : null;
    if (!text) continue;

    const meta = contentMeta(text);
    const score = scoreFile(keys[i], meta, contentBody(text), queryTokens);
    if (score === null) continue;

    candidates.push({
      id: keys[i],
      kind: keys[i].split("/")[0],
      name: meta.name,
      title: meta.title,
      description: meta.description,
      snippet: snippet(text, queryTokens).slice(0, 240),
      score
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { ok: true, results: candidates.slice(0, max), total: candidates.length };
}

/** Read one known document. The id must be in the bucket and under a content kind. */
export async function readContent(env, id) {
  const key = String(id || "").trim();
  if (!PATH.test(key)) {
    return { ok: false, error: "id must be a known reference/ or skills/ Markdown path" };
  }

  const known = await knownContent(env);
  if (!known.has(key)) {
    return { ok: false, error: "no document matched that id" };
  }

  const object = await env.CONTENT.get(key);
  if (!object) return { ok: false, error: "no document matched that id" };

  return {
    ok: true,
    id: key,
    kind: key.split("/")[0],
    content: await object.text()
  };
}
