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

/** Read one known document. The id must be in the bucket and under a content kind. */
export async function readContent(env, id) {
  const key = String(id || "").trim();
  if (!PATH.test(key)) {
    return { ok: false, error: "id must be a known reference/ or skills/ Markdown path" };
  }

  const known = new Set(await listContent(env));
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
