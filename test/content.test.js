import test from "node:test";
import assert from "node:assert/strict";
import {
  KINDS,
  contentMeta,
  listContent,
  briefText,
  readContent
} from "../src/content.js";
import { instructions } from "../src/mcp.js";

/** In-memory stand-in for the R2 binding, with the list options the service uses. */
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { etag: "e1", text: async () => object.text };
    },
    async put(key, value) {
      objects.set(key, { text: String(value) });
      return { key };
    },
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      return { objects: keys.map(key => ({ key })), truncated: false };
    }
  };
}

function env(overrides = {}) {
  const content = bucket();
  content.put("AGENTS.md", `# Working with me

Use the rules and skills in this manual.
`);
  content.put("reference/principles/code-design.md", `---
name: code-design
description: Naming and abstraction choices
---

# Code design
`);
  content.put("reference/languages/php.md", `---
name: php
description: PHP style and tooling
---

# PHP
`);
  content.put("skills/voice.md", `---
name: voice
description: How to write as Zac
---

# Voice
`);
  content.put("skills/writing.md", `---
name: writing
description: Writing for people
---

# Writing
`);
  return { CONTENT: content, ...overrides };
}

test("frontmatter can be read and falls back to the first heading", () => {
  assert.deepEqual(contentMeta("---\ndescription: A thing\n---\n\n# Title\n"), {
    name: "",
    description: "A thing",
    title: "Title"
  });

  assert.deepEqual(contentMeta("# Only a heading\n"), {
    name: "",
    description: "",
    title: "Only a heading"
  });
});

test("brief returns the unchanged entry document and the catalogue", async () => {
  const e = env();
  const expectedEntry = await e.CONTENT.get("AGENTS.md").then(o => o.text());
  const result = await briefText(e);

  assert.equal(result.ok, true);
  assert.equal(result.id, "AGENTS.md");
  assert.ok(result.content.startsWith(expectedEntry));
  assert.match(result.content, /## Available documents/);
  assert.match(result.content, /### reference/);
  assert.match(result.content, /### skills/);
  for (const id of [
    "reference/languages/php.md",
    "reference/principles/code-design.md",
    "skills/voice.md",
    "skills/writing.md"
  ]) {
    assert.match(result.content, new RegExp(`\\\`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\``));
  }
  assert.match(result.content, /reference\/languages\/php\.md` — PHP — PHP style and tooling/);
});

test("brief omits empty kinds but still returns every readable document", async () => {
  const e = env();
  await e.CONTENT.objects.delete("skills/voice.md");
  await e.CONTENT.objects.delete("skills/writing.md");

  const result = await briefText(e);
  assert.equal(result.ok, true);
  assert.match(result.content, /reference\/languages\/php\.md/);
  assert.doesNotMatch(result.content, /### skills/);
});

test("listing only includes Markdown under reference and skills", async () => {
  const e = env();
  await e.CONTENT.put("notes.txt", "not content");
  await e.CONTENT.put("reference/principles/Broken Name.md", "not content");
  await e.CONTENT.put("skills/notes.md", "# Notes\n");

  assert.deepEqual(await listContent(e), [
    "reference/languages/php.md",
    "reference/principles/code-design.md",
    "skills/notes.md",
    "skills/voice.md",
    "skills/writing.md"
  ].sort());
});

test("read returns every requested document in request order", async () => {
  const e = env();
  const voice = await e.CONTENT.get("skills/voice.md").then(o => o.text());
  const design = await e.CONTENT.get("reference/principles/code-design.md").then(o => o.text());

  const found = await readContent(e, { ids: ["skills/voice.md", "reference/principles/code-design.md"] });

  assert.equal(found.ok, true);
  assert.deepEqual(found.documents.map(d => d.id), ["skills/voice.md", "reference/principles/code-design.md"]);
  assert.equal(found.documents[0].content, voice);
  assert.equal(found.documents[0].kind, "skills");
  assert.equal(found.documents[1].content, design);
});

test("read follows @mentions and returns them after the requested documents", async () => {
  const e = env();
  await e.CONTENT.put(
    "skills/deep.md",
    "# Deep\n\nRead @reference/principles/code-design.md first, then @reference/principles/code-design.md again.\n"
  );

  const found = await readContent(e, { ids: ["skills/deep.md"] });

  assert.equal(found.ok, true);
  assert.deepEqual(found.documents.map(d => d.id), [
    "skills/deep.md",
    "reference/principles/code-design.md"
  ]);
  assert.equal(found.documents[0].includedBy, undefined);
  assert.equal(found.documents[1].includedBy, "skills/deep.md");
  assert.equal(found.documents[1].kind, "reference");
  assert.equal(
    found.documents[1].content,
    await e.CONTENT.get("reference/principles/code-design.md").then(o => o.text())
  );
});

test("mentions are followed through included documents and cycles stop", async () => {
  const e = env();
  await e.CONTENT.put("skills/a.md", "# A\n\nSee @reference/principles/b.md and @skills/a.md.\n");
  await e.CONTENT.put("reference/principles/b.md", "# B\n\nSee @reference/principles/c.md and @skills/a.md.\n");
  await e.CONTENT.put("reference/principles/c.md", "# C\n");

  const found = await readContent(e, { ids: ["skills/a.md"] });

  assert.deepEqual(found.documents.map(d => d.id), [
    "skills/a.md",
    "reference/principles/b.md",
    "reference/principles/c.md"
  ]);
  assert.equal(found.documents[1].includedBy, "skills/a.md");
  assert.equal(found.documents[2].includedBy, "reference/principles/b.md");
});

test("mentions inside inline code or a fenced block are examples", async () => {
  const e = env();
  await e.CONTENT.put("skills/code.md", [
    "# Code",
    "",
    "Inline `@reference/principles/code-design.md` is an example.",
    "",
    "Double backticks ``@reference/languages/php.md`` are too.",
    "",
    "A span can run over",
    "lines: `@reference/principles/absent.md",
    "still code` and it stays literal.",
    "",
    "````markdown",
    "```",
    "@reference/principles/absent.md",
    "```",
    "````",
    "",
    "A stray ` does not hide @skills/voice.md.",
    "",
    "A second stray ` does not hide @skills/writing.md.",
    ""
  ].join("\n"));

  const found = await readContent(e, { ids: ["skills/code.md"] });

  assert.deepEqual(found.documents.map(d => d.id), [
    "skills/code.md",
    "skills/voice.md",
    "skills/writing.md"
  ]);
});

test("a mention of a missing document fails only its own entry", async () => {
  const e = env();
  await e.CONTENT.put("skills/missing.md", "# Missing\n\nSee @reference/principles/absent.md.\n");

  const found = await readContent(e, { ids: ["skills/missing.md"] });

  assert.equal(found.ok, true);
  assert.equal(found.documents[0].ok, true);
  assert.equal(found.documents[1].ok, false);
  assert.equal(found.documents[1].id, "reference/principles/absent.md");
  assert.equal(found.documents[1].includedBy, "skills/missing.md");
});

test("a document that is both requested and mentioned comes back once", async () => {
  const e = env();
  await e.CONTENT.put("skills/needs-design.md", "# Needs design\n\nSee @reference/principles/code-design.md.\n");

  const found = await readContent(e, {
    ids: ["reference/principles/code-design.md", "skills/needs-design.md"]
  });

  assert.deepEqual(found.documents.map(d => d.id), [
    "reference/principles/code-design.md",
    "skills/needs-design.md"
  ]);
  assert.equal(found.documents[0].includedBy, undefined);
});

test("one bad id fails only its own entry", async () => {
  const e = env();
  const found = await readContent(e, {
    ids: ["skills/voice.md", "skills/missing.md", "AGENTS.md", "../skills/writing.md"]
  });

  assert.equal(found.ok, true);
  assert.equal(found.documents[0].ok, true);
  assert.equal(found.documents[1].ok, false);
  assert.match(found.documents[1].error, /no document matched/);
  assert.equal(found.documents[2].ok, false);
  assert.match(found.documents[2].error, /reference\/ or skills\//);
  assert.equal(found.documents[3].ok, false);
});

test("read still accepts a single id and rejects an empty or oversized request", async () => {
  const e = env();
  assert.deepEqual((await readContent(e, { id: "skills/voice.md" })).documents.map(d => d.id), ["skills/voice.md"]);
  assert.equal((await readContent(e, {})).ok, false);
  assert.equal((await readContent(e, { ids: Array.from({ length: 51 }, () => "skills/voice.md") })).ok, false);
});

test("the instructions do not name a person or this deployment", () => {
  assert.doesNotMatch(instructions(), /Zac/);
  assert.doesNotMatch(instructions(), /reference\/principles/);
});

test("the supported kinds are stable", () => {
  assert.deepEqual([...KINDS], ["reference", "skills"]);
});
