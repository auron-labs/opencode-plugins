import test from "node:test"
import assert from "node:assert/strict"
import { parseFindings } from "../dist/detector.js"
import { isDetectorCandidate, isTier1Candidate, isQuietCandidate } from "../dist/tools.js"

test("isDetectorCandidate accepts only UI extensions", () => {
  assert.equal(isDetectorCandidate("src/Button.tsx"), true)
  assert.equal(isDetectorCandidate("src/index.html"), true)
  assert.equal(isDetectorCandidate("src/app.vue"), true)
  assert.equal(isDetectorCandidate("src/main.js"), true)
  assert.equal(isDetectorCandidate("src/main.ts"), true)
  assert.equal(isDetectorCandidate("src/main.css"), true)
  assert.equal(isDetectorCandidate("src/main.scss"), true)
  assert.equal(isDetectorCandidate("README.md"), false)
  assert.equal(isDetectorCandidate("package.json"), false)
  assert.equal(isDetectorCandidate("src/index"), false)
})

test("isTier1Candidate treats .ts and .js as quieter (not tier1)", () => {
  assert.equal(isTier1Candidate("src/Button.tsx"), true)
  assert.equal(isTier1Candidate("src/main.ts"), false)
  assert.equal(isTier1Candidate("src/app.vue"), true)
})

test("isQuietCandidate treats .ts and .js as the quiet set", () => {
  assert.equal(isQuietCandidate("src/main.ts"), true)
  assert.equal(isQuietCandidate("src/main.js"), true)
  assert.equal(isQuietCandidate("src/Button.tsx"), false)
})

test("parseFindings parses array JSON", () => {
  const findings = parseFindings({
    ok: true,
    code: 0,
    stdout: JSON.stringify([
      { rule: "overused-font", message: "Inter is overused", file: "src/App.tsx" },
    ]),
    stderr: "",
    parsed: null,
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, "overused-font")
  assert.equal(findings[0].file, "src/App.tsx")
})

test("parseFindings parses {findings: [...]} JSON envelope", () => {
  const findings = parseFindings({
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      findings: [{ rule: "low-contrast", message: "Text below 4.5:1", line: 12 }],
    }),
    stderr: "",
    parsed: null,
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, "low-contrast")
})

test("parseFindings falls back to a placeholder finding for non-JSON output", () => {
  const findings = parseFindings({
    ok: true,
    code: 0,
    stdout: "1 finding:\n  src/Button.tsx  overused-font Inter\n",
    stderr: "",
    parsed: null,
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, "detector-output")
  assert.ok(findings[0].message.includes("overused-font Inter"))
})

test("parseFindings returns an empty list when there is no output", () => {
  const findings = parseFindings({
    ok: true,
    code: 0,
    stdout: "",
    stderr: "",
    parsed: null,
  })
  assert.deepEqual(findings, [])
})