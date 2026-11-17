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

const CONTENT_PATH = "(?:reference|skills)\\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*\\.md";
const PATH = new RegExp(`^${CONTENT_PATH}$`);
const MENTION = new RegExp(`@(${CONTENT_PATH})`, "g");
const FENCE = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;
const FRONT_VALUE = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/;
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

/**
 * Return the entire entry document unchanged, followed by a catalogue of the
 * readable documents generated from the current bucket.
 */
export async function briefText(env) {
  const entry = env.ENTRY_FILE || "AGENTS.md";
  const object = await env.CONTENT.get(entry);
  if (!object) {
    return { ok: false, error: `content bucket is missing ${entry}` };
  }

  const keys = await listContent(env);
  const documents = await Promise.all(keys.map(key => env.CONTENT.get(key)));
  const sections = Object.fromEntries(KINDS.map(kind => [kind, []]));

  for (let i = 0; i < keys.length; i++) {
    const text = documents[i] ? await documents[i].text() : null;
    if (!text) continue;
    const kind = keys[i].split("/")[0];
    const meta = contentMeta(text);
    sections[kind].push({
      id: keys[i],
      title: meta.title || meta.name || keys[i],
      description: meta.description
    });
  }

  const lines = [await object.text(), "", "---", "", "## Available documents"];
  for (const kind of KINDS) {
    if (!sections[kind].length) continue;
    lines.push("", `### ${kind}`, "");
    for (const document of sections[kind]) {
      const description = document.description ? ` — ${document.description}` : "";
      lines.push(`- \`${document.id}\` — ${document.title}${description}`);
    }
  }

  return { ok: true, id: entry, content: lines.join("\n") };
}

/** Return the document's Markdown, or null when the id is unknown or malformed. */
async function loadDocument(env, known, path) {
  if (!PATH.test(path) || !known.has(path)) return null;
  const object = await env.CONTENT.get(path);
  return object ? object.text() : null;
}

/**
 * The document ids named as @reference/... or @skills/... in the Markdown.
 * Mentions inside inline code or a fenced block are examples, not includes.
 */
function mentionedIds(text) {
  const prose = [];
  let fence = null;

  for (const line of text.split("\n")) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      // A fence closes on the same character, at least as long, with nothing after it.
      const closes = marker
        && marker[0] === fence[0]
        && marker.length >= fence.length
        && !line.trimStart().slice(marker.length).trim();
      if (closes) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    prose.push(line);
  }

  // An inline code span can run over a line ending but not over a blank line,
  // so strip it one paragraph at a time.
  const ids = [];
  for (const paragraph of prose.join("\n").split(/\n[ \t]*\n/)) {
    for (const match of paragraph.replace(INLINE_CODE, "").matchAll(MENTION)) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/**
 * Read several documents in one call: `{ ids: [...] }` returns one entry per id
 * in request order, so an agent can load a rule and a skill together. A missing
 * or malformed id fails only its own entry; the rest still come back.
 *
 * Documents that name another as @reference/... pull it in, and that document's
 * own mentions are followed too. Included documents come after the requested
 * ones, once each, with includedBy naming the document that mentioned them.
 *
 *   { ok: true, documents: [
 *     {id, kind, content},
 *     {id, kind, content, includedBy},
 *     {id, ok: false, error, includedBy}
 *   ] }
 */
export async function readContent(env, { id, ids } = {}) {
  const requested = ids?.length ? ids : id === undefined ? [] : [id];
  if (!requested.length) return { ok: false, error: "pass ids, or id for a single document" };
  if (requested.length > 50) return { ok: false, error: "at most 50 ids per call" };

  const keyed = requested.map(value => String(value ?? "").trim());

  const known = new Set(await listContent(env));
  const contents = await Promise.all(keyed.map(path => loadDocument(env, known, path)));

  const documents = [];
  for (let i = 0; i < keyed.length; i++) {
    const path = keyed[i];
    const content = contents[i];
    if (content === null) {
      documents.push({
        id: path,
        ok: false,
        error: PATH.test(path) ? "no document matched that id" : "id must be a reference/ or skills/ Markdown path"
      });
      continue;
    }
    documents.push({ id: path, ok: true, kind: path.split("/")[0], content });
  }

  // Walk the growing list, so each included document's own mentions are followed
  // too. An id already returned is skipped, which also stops cycles.
  const returned = new Set(keyed);
  for (let i = 0; i < documents.length; i++) {
    const source = documents[i];
    if (!source.ok) continue;

    const mentioned = [];
    for (const path of mentionedIds(source.content)) {
      if (returned.has(path)) continue;
      returned.add(path);
      mentioned.push(path);
    }

    const added = await Promise.all(mentioned.map(path => loadDocument(env, known, path)));
    for (let j = 0; j < mentioned.length; j++) {
      const path = mentioned[j];
      const content = added[j];
      if (content === null) {
        documents.push({
          id: path,
          ok: false,
          error: "no document matched that id",
          includedBy: source.id
        });
        continue;
      }
      documents.push({
        id: path,
        ok: true,
        kind: path.split("/")[0],
        content,
        includedBy: source.id
      });
    }
  }

  return { ok: true, documents };
}
