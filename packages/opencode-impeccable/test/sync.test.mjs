import test from "node:test"
import assert from "node:assert/strict"
import {
  REPO,
  REF,
  SKILL_PATH,
  REFERENCES_SUBDIR,
  filterImpeccableReferences,
  findStaleLocals,
  rawUrl,
  treeUrl,
  diffLines,
} from "../scripts/sync-impeccable-upstream.mjs"

test("filterImpeccableReferences picks up flat *.md under references/ and excludes SKILL.md", () => {
  const tree = {
    truncated: false,
    tree: [
      { path: "README.md", type: "blob" },
      { path: `${SKILL_PATH}/SKILL.md`, type: "blob" },
      { path: `${SKILL_PATH}/agents/foo.toml`, type: "blob" },
      { path: `${SKILL_PATH}/${REFERENCES_SUBDIR}/audit.md`, type: "blob" },
      { path: `${SKILL_PATH}/${REFERENCES_SUBDIR}/hooks.md`, type: "blob" },
      { path: `${SKILL_PATH}/${REFERENCES_SUBDIR}/live-setup.md`, type: "blob" },
      { path: `${SKILL_PATH}/${REFERENCES_SUBDIR}/notes.json`, type: "blob" },
      { path: `${SKILL_PATH}/${REFERENCES_SUBDIR}/degraded/foo.md`, type: "blob" },
      { path: `other-skill/SKILL.md`, type: "blob" },
    ],
  }
  const files = filterImpeccableReferences(tree)
  assert.deepEqual(files, [
    { local: "audit.md", upstream: "audit.md" },
    { local: "hooks.md", upstream: "hooks.md" },
    { local: "live-setup.md", upstream: "live-setup.md" },
  ])
})

test("filterImpeccableReferences throws on truncated trees so we never silently sync a subset", () => {
  assert.throws(
    () => filterImpeccableReferences({ truncated: true, tree: [] }),
    new RegExp(`Tree response for ${REPO}@${REF} was truncated`),
  )
})

test("findStaleLocals returns only local files not present in upstream, sorted", () => {
  const files = [
    { local: "audit.md", upstream: "audit.md" },
    { local: "hooks.md", upstream: "hooks.md" },
  ]
  const localNames = ["audit.md", "hooks.md", "stale.md", "extra.md"]
  assert.deepEqual(findStaleLocals(files, localNames), ["extra.md", "stale.md"])
})

test("findStaleLocals dedupes and is stable on reordering", () => {
  const files = [{ local: "audit.md", upstream: "audit.md" }]
  const localNames = ["b.md", "a.md", "b.md", "a.md"]
  assert.deepEqual(findStaleLocals(files, localNames), ["a.md", "b.md"])
})

test("diffLines reports only changed lines with stable prefixes", () => {
  const local = "a\nb\nc\n"
  const upstream = "a\nB\nc\n"
  const out = diffLines("    ", local, upstream)
  assert.match(out, /2 - b/)
  assert.match(out, /2 \+ B/)
  assert.doesNotMatch(out, /1 - /)
  assert.doesNotMatch(out, /3 - /)
})

test("rawUrl and treeUrl point at the expected pbakaus/impeccable@main endpoints", () => {
  assert.equal(
    treeUrl(),
    `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`,
  )
  assert.equal(
    rawUrl("audit.md"),
    `https://raw.githubusercontent.com/${REPO}/${REF}/${SKILL_PATH}/${REFERENCES_SUBDIR}/audit.md`,
  )
})