import test from "node:test"
import assert from "node:assert/strict"

import {
  BRANCH,
  REPO,
  commitUrl,
  diffLines,
  filterImpeccableFiles,
  findStaleLocals,
  isMainModule,
  localPathForUpstream,
  rawUrl,
  treeUrl,
} from "../scripts/sync-impeccable-upstream.mjs"

test("sync module is import-safe", () => {
  assert.equal(isMainModule("file:///not-the-entry.mjs", "/tmp/entry.mjs"), false)
})

test("managed upstream paths map into references and the bundled runtime", () => {
  assert.equal(localPathForUpstream("skill/SKILL.src.md"), "references/SKILL.md")
  assert.equal(localPathForUpstream("skill/reference/polish.md"), "references/polish.md")
  assert.equal(localPathForUpstream("skill/agents/impeccable-documenter.md"), "vendor/impeccable/skill/agents/impeccable-documenter.md")
  assert.equal(localPathForUpstream("skill/scripts/live/poll-lanes.mjs"), "vendor/impeccable/skill/scripts/live/poll-lanes.mjs")
  assert.equal(localPathForUpstream("cli/engine/detect-antipatterns.mjs"), "vendor/impeccable/cli/engine/detect-antipatterns.mjs")
  assert.equal(localPathForUpstream("README.md"), null)
})

test("filterImpeccableFiles selects a coherent runtime and sorts local paths", () => {
  const files = filterImpeccableFiles({
    truncated: false,
    tree: [
      { path: "README.md", type: "blob" },
      { path: "cli/engine/detect.mjs", type: "blob" },
      { path: "skill/scripts/context.mjs", type: "blob" },
      { path: "skill/reference/polish.md", type: "blob" },
      { path: "skill/SKILL.src.md", type: "blob" },
      { path: "skill/agents/impeccable-documenter.md", type: "blob" },
      { path: "skill/scripts/live", type: "tree" },
      { path: "LICENSE", type: "blob" },
    ],
  })
  assert.deepEqual(files.map((file) => file.local), [
    "references/SKILL.md",
    "references/polish.md",
    "vendor/impeccable/LICENSE",
    "vendor/impeccable/cli/engine/detect.mjs",
    "vendor/impeccable/skill/agents/impeccable-documenter.md",
    "vendor/impeccable/skill/scripts/context.mjs",
  ])
})

test("truncated trees are rejected", () => {
  assert.throws(() => filterImpeccableFiles({ truncated: true, tree: [] }), /truncated/)
})

test("stale local discovery is stable and deduplicated", () => {
  const files = [{ local: "references/a.md" }, { local: "references/b.md" }]
  assert.deepEqual(
    findStaleLocals(files, ["references/c.md", "references/a.md", "references/c.md"]),
    ["references/c.md"],
  )
})

test("diffLines reports only changed lines", () => {
  const diff = diffLines("  ", "a\nb\nc\n", "a\nB\nc\n")
  assert.match(diff, /2 - b/)
  assert.match(diff, /2 \+ B/)
  assert.doesNotMatch(diff, /1 - a/)
})

test("URLs address the requested repository and immutable ref", () => {
  const ref = "abc123"
  assert.equal(treeUrl(ref), `https://api.github.com/repos/${REPO}/git/trees/${ref}?recursive=1`)
  assert.equal(commitUrl(), `https://api.github.com/repos/${REPO}/commits/${BRANCH}`)
  assert.equal(rawUrl("skill/SKILL.src.md", ref), `https://raw.githubusercontent.com/${REPO}/${ref}/skill/SKILL.src.md`)
})
