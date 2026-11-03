import test from "node:test";
import assert from "node:assert/strict";
import {
  KINDS,
  contentMeta,
  listContent,
  searchContent,
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
  const mem = bucket();
  mem.put("AGENTS.md", `# Working with me

Use the rules and skills in this manual.
`);
  mem.put("reference/principles/code-design.md", `---
name: code-design
description: Naming and abstraction choices
---

# Code design

Small helpers live on the domain class.
`);
  mem.put("reference/principles/security.md", `---
name: security
description: Security rules
---

# Security

Never print secrets into a transcript.
`);
  mem.put("reference/languages/php.md", `---
name: php
description: PHP style and tooling
---

# PHP

Use strict types.
`);
  mem.put("skills/voice.md", `---
name: voice
description: How to write as Zac
---

# Voice

Plain words.
`);
  mem.put("skills/writing.md", `---
name: writing
description: Writing for people
---

# Writing

Stable facts over guesses.
`);
  return { CONTENT: mem, ...overrides };
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

test("listing only includes Markdown under reference and skills", async () => {
  const e = env();
  await e.CONTENT.put("notes.txt", "not content");
  await e.CONTENT.put("reference/principles/Broken Name.md", "not content");
  await e.CONTENT.put("skills/notes.md", "# Appraisals\n");

  assert.deepEqual(await listContent(e), [
    "reference/languages/php.md",
    "reference/principles/code-design.md",
    "reference/principles/security.md",
    "skills/notes.md",
    "skills/voice.md",
    "skills/writing.md"
  ]);
});

test("search without a query returns the whole catalogue", async () => {
  const { results } = await searchContent(env(), {});
  assert.deepEqual(
    results.map(result => result.id),
    [
      "reference/languages/php.md",
      "reference/principles/code-design.md",
      "reference/principles/security.md",
      "skills/voice.md",
      "skills/writing.md"
    ]
  );
});

test("search matches descriptions and content, and kind filters them", async () => {
  const e = env();
  assert.deepEqual(
    (await searchContent(e, { query: "write as zac" })).results.map(result => result.id),
    ["skills/voice.md"]
  );
  assert.deepEqual(
    (await searchContent(e, { query: "stale facts" })).results.map(result => result.id),
    []
  );
  assert.deepEqual(
    (await searchContent(e, { query: "strict types", kind: "reference" })).results.map(result => result.id),
    ["reference/languages/php.md"]
  );
  assert.deepEqual((await searchContent(e, { query: "strict types", kind: "skills" })).results, []);
});

test("search returns matching snippets and respects the limit", async () => {
  const e = env();
  const one = await searchContent(e, { query: "secrets", limit: 1 });
  assert.equal(one.results.length, 1);
  assert.equal(one.results[0].id, "reference/principles/security.md");
  assert.match(one.results[0].snippet, /secrets/);
  assert.equal((await searchContent(e, { query: "secrets", limit: 100 })).results.length, 1);
});

test("read returns the exact file content and validates known ids", async () => {
  const e = env();
  const expected = await e.CONTENT.get("skills/writing.md").then(o => o.text());
  const found = await readContent(e, "skills/writing.md");

  assert.equal(found.ok, true);
  assert.equal(found.content, expected);
  assert.equal(found.kind, "skills");

  assert.equal((await readContent(e, "../skills/writing.md")).ok, false);
  assert.equal((await readContent(e, "AGENTS.md")).ok, false);
  assert.equal((await readContent(e, "skills/missing.md")).ok, false);
  assert.equal((await readContent(e, "skills/../principles/code-design.md")).ok, false);
  assert.equal((await readContent(e, "principles/code-design.md")).ok, false);
});

test("the instructions do not name a person or this deployment", () => {
  assert.doesNotMatch(instructions(), /Zac/);
  assert.doesNotMatch(instructions(), /reference\/principles/);
});

test("the supported kinds are stable", () => {
  assert.deepEqual([...KINDS], ["reference", "skills"]);
});
