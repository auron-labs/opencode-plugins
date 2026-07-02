import test from "node:test";
import assert from "node:assert/strict";

import {
  REPO,
  REF,
  SKILL_PATH,
  diffLines,
  filterSkillFiles,
  findStaleLocals,
  rawUrl,
  treeUrl,
} from "./sync-improve-upstream.lib.mjs";

test("filterSkillFiles picks up SKILL.md and flat references/*.md only", () => {
  const tree = {
    truncated: false,
    tree: [
      { path: "README.md", type: "blob" },
      { path: `${SKILL_PATH}/SKILL.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/audit-playbook.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/closing-the-loop.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/plan-template.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/notes.json`, type: "blob" },
      { path: `${SKILL_PATH}/references/nested/inner.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/templates/foo.txt`, type: "blob" },
      { path: "skills/other/SKILL.md", type: "blob" },
      { path: `${SKILL_PATH}/references`, type: "tree" },
    ],
  };

  const files = filterSkillFiles(tree);

  assert.deepEqual(files, [
    { local: "SKILL.md", upstream: "SKILL.md" },
    { local: "audit-playbook.md", upstream: "references/audit-playbook.md" },
    { local: "closing-the-loop.md", upstream: "references/closing-the-loop.md" },
    { local: "plan-template.md", upstream: "references/plan-template.md" },
  ]);
});

test("filterSkillFiles surfaces new and renamed upstream files automatically", () => {
  const tree = {
    truncated: false,
    tree: [
      { path: `${SKILL_PATH}/SKILL.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/audit-checklist.md`, type: "blob" },
      { path: `${SKILL_PATH}/references/brand-new.md`, type: "blob" },
    ],
  };

  const files = filterSkillFiles(tree);

  assert.equal(files.length, 3);
  assert.ok(files.some((f) => f.local === "audit-checklist.md"));
  assert.ok(files.some((f) => f.local === "brand-new.md"));
  assert.ok(!files.some((f) => f.local === "audit-playbook.md"));
});

test("filterSkillFiles throws on truncated trees so we never silently sync a subset", () => {
  const tree = { truncated: true, tree: [] };
  assert.throws(
    () => filterSkillFiles(tree),
    new RegExp(`Tree response for ${REPO}@${REF} was truncated`),
  );
});

test("filterSkillFiles supports custom skill paths for testing downstream consumers", () => {
  const tree = {
    truncated: false,
    tree: [
      { path: "plugins/foo/skills/audit/SKILL.md", type: "blob" },
      { path: "plugins/foo/skills/audit/references/payload.md", type: "blob" },
    ],
  };

  const files = filterSkillFiles(tree, {
    skillPath: "plugins/foo/skills/audit",
  });

  assert.deepEqual(files, [
    { local: "SKILL.md", upstream: "SKILL.md" },
    { local: "payload.md", upstream: "references/payload.md" },
  ]);
});

test("findStaleLocals returns only local files not present in upstream, sorted", () => {
  const files = [
    { local: "SKILL.md", upstream: "SKILL.md" },
    { local: "audit-playbook.md", upstream: "references/audit-playbook.md" },
  ];
  const localNames = [
    "SKILL.md",
    "audit-playbook.md",
    "plan-template.md",
    "stale.md",
  ];

  assert.deepEqual(findStaleLocals(files, localNames), [
    "plan-template.md",
    "stale.md",
  ]);
});

test("findStaleLocals dedupes and is stable on reordering", () => {
  const files = [{ local: "SKILL.md", upstream: "SKILL.md" }];
  const localNames = ["b.md", "a.md", "b.md", "a.md"];

  assert.deepEqual(findStaleLocals(files, localNames), ["a.md", "b.md"]);
});

test("diffLines reports only changed lines with stable prefixes", () => {
  const local = "a\nb\nc\n";
  const upstream = "a\nB\nc\n";
  const out = diffLines("    ", local, upstream);

  assert.match(out, /2 - b/);
  assert.match(out, /2 \+ B/);
  assert.doesNotMatch(out, /1 - /);
  assert.doesNotMatch(out, /3 - /);
});

test("rawUrl and treeUrl point at the expected shadcn/improve@main endpoints", () => {
  assert.equal(
    treeUrl(),
    `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`,
  );
  assert.equal(
    rawUrl("references/audit-playbook.md"),
    `https://raw.githubusercontent.com/${REPO}/${REF}/${SKILL_PATH}/references/audit-playbook.md`,
  );
});
