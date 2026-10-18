/* oxlint-disable eslint/no-await-in-loop -- These tests verify sequential state transitions and preservation across corrupt inputs. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildStateTools } from "../dist/state-tools.js";
import {
  loadCheckpoint,
  STATE_RELATIVE_PATH,
  StateStore,
} from "../dist/state.js";

const run = promisify(execFile);
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const context = {
  agent: "pstack",
  id: "call",
  messageID: "message",
  progress() {},
  sessionID: "test-session",
  signal: new AbortController().signal,
};

const fixture = async (t) => {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "opencode-pstack-state-")
  );
  t.after(() => rm(directory, { force: true, recursive: true }));
  const tools = buildStateTools(directory, async () => {});
  const call = async (name, input, ctx = context) =>
    JSON.parse(
      await tools
        .find((tool) => tool.name === name)
        .execute(input, ctx)
        .then((result) => result.content)
    );
  return {
    call,
    directory,
    path: nodePath.join(directory, STATE_RELATIVE_PATH),
    tools,
  };
};

test("read tools do not create state and mutations require explicit native authorization", async (t) => {
  const { directory, tools, call } = await fixture(t);
  const initial = await call("pstack_status", {});
  assert.equal(initial.state.revision, 0);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await loadCheckpoint(directory), undefined);
  for (const tool of tools) {
    assert.equal(
      tool.options.permission,
      tool.name.endsWith("_read") || tool.name === "pstack_status"
        ? undefined
        : "pstack_write"
    );
  }
  const denied = buildStateTools(directory, () => {
    throw new Error("native permission denied");
  });
  await assert.rejects(
    denied
      .find((tool) => tool.name === "pstack_standing")
      .execute({ action: "add", line: "Keep the diff small" }, context),
    /native permission denied/u
  );
  assert.deepEqual(await readdir(directory), []);
});

test("ledger persists exact PR and full SHA receipts, replacing only the same key", async (t) => {
  const { directory, call } = await fixture(t);
  const record = {
    action: "record",
    evidence: "artifact:unit-tests",
    pr: 23,
    sha: SHA.toUpperCase(),
    verdict: "unit-test-verified",
  };
  await call("pstack_ledger", record);
  const restored = buildStateTools(directory, async () => {});
  const check = async (sha) => {
    const receipt = await restored
      .find((tool) => tool.name === "pstack_ledger_read")
      .execute({ action: "check", pr: 23, sha }, context);
    return JSON.parse(receipt.content);
  };
  const verified = await check(SHA);
  assert.equal(verified.verified, true);
  assert.deepEqual(await check(NEXT_SHA), {
    entry: null,
    pr: 23,
    sha: NEXT_SHA,
    verdict: "NOT-VERIFIED",
    verified: false,
  });
  for (const verdict of [
    "type-check-only",
    "verifier-blocked",
    "verifier-failed",
  ]) {
    await call("pstack_ledger", { ...record, verdict });
    const checked = await check(SHA);
    assert.equal(checked.verified, false);
  }
  const entries = await call("pstack_ledger_read", { action: "list" });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].actor, {
    agent: "pstack",
    sessionID: "test-session",
  });
  await assert.rejects(call("pstack_ledger", { ...record, sha: "abc123" }));
  await assert.rejects(call("pstack_ledger", { ...record, evidence: " " }));
  await assert.rejects(
    call("pstack_ledger", {
      ...record,
      actor: { agent: "verifier", sessionID: "forged" },
    })
  );
});

test("unit, gate, frontier and standing-order state survive a new store instance", async (t) => {
  const { directory, call } = await fixture(t);
  await call("pstack_unit", {
    action: "add",
    brief: "artifact:feature-plan",
    id: "feature-one",
    track: "build",
  });
  await call("pstack_unit", {
    action: "set",
    branch: "feature/one",
    id: "feature-one",
    pr: 23,
    sha: SHA,
    state: "verifying",
  });
  await call("pstack_unit", {
    action: "set",
    id: "feature-one",
    state: "done",
  });
  const unit = await call("pstack_unit_read", {
    action: "get",
    id: "feature-one",
  });
  assert.equal(unit.sha, SHA);
  const units = await call("pstack_unit_read", {
    action: "list",
    state: "done",
    track: "build",
  });
  assert.equal(units.length, 1);
  await assert.rejects(
    call("pstack_unit", { action: "add", id: "feature-one", track: "build" }),
    /already exists/u
  );
  await call("pstack_standing", {
    action: "add",
    line: "Only the coordinator may merge",
  });
  await call("pstack_gate", {
    action: "park",
    defaultAnswer: "small",
    id: "design",
    options: ["small", "large"],
    question: "Which layout?",
  });
  const gates = await call("pstack_gate_read", { action: "list" });
  assert.equal(gates.length, 1);
  await call("pstack_gate", {
    action: "resolve",
    answer: "large",
    id: "design",
  });
  assert.deepEqual(await call("pstack_gate_read", { action: "list" }), []);
  const prs = [{ branch: "feature/one", pr: 23, sha: SHA, state: "OPEN" }];
  const frontier = await call("pstack_frontier", { action: "set", prs });
  assert.equal(frontier.lowestUnmerged, 23);
  await assert.rejects(
    call("pstack_frontier", { action: "set", prs: [...prs, ...prs] }),
    /duplicate/u
  );
  const state = await new StateStore(directory).read();
  assert.equal(state.frontier.generation, 1);
  assert.equal(state.gates[0].answer, "large");
  assert.deepEqual(state.standing, ["Only the coordinator may merge"]);
  assert.equal(state.units[0].branch, "feature/one");
});

test("inbox drain is atomic and sender identity comes from execution context", async (t) => {
  const { directory, call } = await fixture(t);
  const otherTools = buildStateTools(directory, async () => {});
  await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const tool = otherTools.find((entry) => entry.name === "pstack_inbox");
      return tool.execute(
        {
          action: "push",
          report: "artifact:report",
          status: "done",
          unit: `unit-${index}`,
        },
        { ...context, agent: `worker-${index}` }
      );
    })
  );
  const inbox = await call("pstack_inbox_read", { action: "peek" });
  assert.equal(inbox.length, 12);
  const drained = await call("pstack_inbox", { action: "drain" });
  assert.equal(new Set(drained.map((entry) => entry.id)).size, 12);
  assert.equal(new Set(drained.map((entry) => entry.agent)).size, 12);
  assert.deepEqual(await call("pstack_inbox", { action: "drain" }), []);
});

test("native artifacts are bounded names and decisions stay append-only", async (t) => {
  const { directory, call } = await fixture(t);
  await call("pstack_artifact", {
    action: "write",
    content: "# Plan\nImplement the feature.",
    kind: "plan",
    name: "feature-plan",
  });
  await call("pstack_artifact", {
    action: "write",
    content: "# Revised plan",
    kind: "plan",
    name: "feature-plan",
  });
  const artifact = await call("pstack_artifact_read", {
    action: "read",
    name: "feature-plan",
  });
  assert.equal(artifact.content, "# Revised plan");
  const artifacts = await call("pstack_artifact_read", { action: "list" });
  assert.equal(artifacts.length, 1);
  await assert.rejects(
    call("pstack_artifact", {
      action: "write",
      content: "no",
      kind: "plan",
      name: "../outside",
    })
  );
  await assert.rejects(
    call("pstack_artifact", {
      action: "write",
      content: "🔥".repeat(20_000),
      kind: "note",
      name: "oversized",
    }),
    /64 KiB/u
  );
  const decision = {
    action: "append",
    decision: "Use native tools",
    evidence: "artifact:feature-plan",
    phase: "design",
    result: "accepted",
    why: "Keep state typed",
  };
  await call("pstack_decision", decision);
  await call("pstack_decision", {
    ...decision,
    result: "superseded by a smaller design",
  });
  await assert.rejects(
    call("pstack_decision", { ...decision, action: "delete" })
  );
  const entries = await call("pstack_decision_read", { action: "list" });
  assert.deepEqual(
    entries.map((entry) => entry.result),
    ["accepted", "superseded by a smaller design"]
  );
  const checkpoint = await loadCheckpoint(directory);
  assert.match(checkpoint, /feature-plan/u);
  assert.doesNotMatch(checkpoint, /Revised plan|Keep state typed/u);
  const fileInfo = await stat(nodePath.join(directory, STATE_RELATIVE_PATH));
  assert.equal(fileInfo.mode % 0o1000, 0o600);
});

test("corrupt and structurally invalid state is preserved and never reset", async (t) => {
  const { path, directory, call } = await fixture(t);
  await mkdir(nodePath.join(directory, ".opencode", "pstack"), {
    recursive: true,
  });
  for (const raw of ["{broken", JSON.stringify({ schemaVersion: 900 })]) {
    await writeFile(path, raw);
    await assert.rejects(call("pstack_status", {}), /invalid state/u);
    await assert.rejects(
      call("pstack_standing", { action: "add", line: "do not reset" }),
      /invalid state/u
    );
    assert.equal(await readFile(path, "utf-8"), raw);
    assert.deepEqual(
      await readdir(nodePath.join(directory, ".opencode", "pstack")),
      ["state.json"]
    );
  }
});

test("state refuses symlinked directories, state files and locks", async (t) => {
  const { directory, call } = await fixture(t);
  const outside = await mkdtemp(nodePath.join(tmpdir(), "pstack-outside-"));
  t.after(() => rm(outside, { force: true, recursive: true }));
  await symlink(outside, nodePath.join(directory, ".opencode"));
  await assert.rejects(call("pstack_status", {}), /symlink/u);
  await assert.rejects(
    call("pstack_standing", { action: "add", line: "unsafe" }),
    /symlink/u
  );
  await rm(nodePath.join(directory, ".opencode"));
  await mkdir(nodePath.join(directory, ".opencode", "pstack"), {
    recursive: true,
  });
  await writeFile(nodePath.join(outside, "private"), "secret");
  const stateDirectory = nodePath.join(directory, ".opencode", "pstack");
  await symlink(
    nodePath.join(outside, "private"),
    nodePath.join(stateDirectory, "state.json")
  );
  await assert.rejects(call("pstack_status", {}), /regular state file/u);
  await rm(nodePath.join(stateDirectory, "state.json"));
  await symlink(
    nodePath.join(outside, "private"),
    nodePath.join(stateDirectory, ".lock")
  );
  await assert.rejects(
    call("pstack_standing", { action: "add", line: "unsafe" }),
    /regular state file/u
  );
  assert.equal(
    await readFile(nodePath.join(outside, "private"), "utf-8"),
    "secret"
  );
});

test("concurrent processes preserve all acknowledged writes", async (t) => {
  const { directory } = await fixture(t);
  const moduleURL = new URL("../dist/state.js", import.meta.url).href;
  const script = `
    import { StateStore } from ${JSON.stringify(moduleURL)};
    const store = new StateStore(process.argv[1]);
    for (let index = 0; index < 8; index += 1) {
      await store.change({sessionID: process.argv[2], agent: 'worker'}, state => {
        state.standing.push(process.argv[2] + ':' + index);
      });
    }
  `;
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      run(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        directory,
        `worker-${index}`,
      ])
    )
  );
  const state = await new StateStore(directory).read();
  assert.equal(state.revision, 40);
  assert.equal(new Set(state.standing).size, 40);
  const files = await readdir(nodePath.join(directory, ".opencode", "pstack"));
  assert.equal(
    files.filter((name) => name.endsWith(".tmp") || name === ".lock").length,
    0
  );
});

test("checkpoints bound large collections and escaped state strings while retaining exact totals", async (t) => {
  const { directory, call } = await fixture(t);
  const store = new StateStore(directory);
  await store.change(
    { agent: "pstack", sessionID: "test-session" },
    (state) => {
      for (let index = 0; index < 300; index += 1) {
        const id = `unit-${index}-${"x".repeat(110)}`;
        state.units.push({
          id,
          state: `${index}:"\\\u0001🔥`.repeat(800),
          track: "build",
        });
        state.gates.push({
          defaultAnswer: "continue",
          id,
          kind: "open",
          options: ["continue"],
          question: "Continue?",
        });
        state.artifacts.push({
          actor: { agent: "pstack", sessionID: "test-session" },
          content: "A working report",
          kind: "report",
          name: id,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  );
  const raw = await loadCheckpoint(directory);
  assert.ok(Buffer.byteLength(raw) <= 8192);
  const checkpoint = JSON.parse(raw);
  assert.equal(checkpoint.revision, 1);
  assert.deepEqual(checkpoint.counts, {
    artifacts: 300,
    decisions: 0,
    gates: 300,
    inbox: 0,
    ledger: 0,
    openGates: 300,
    standing: 0,
    units: 300,
  });
  assert.equal(checkpoint.units.length, 6);
  assert.equal(checkpoint.artifacts.length, 6);
  assert.equal(checkpoint.summary.openGateIds.length, 6);
  assert.ok(checkpoint.units.every((unit) => unit.stateTruncated));
  assert.ok(
    checkpoint.units.every((unit) => [...unit.statePreview].length <= 64)
  );
  assert.match(checkpoint.units.at(-1).id, /^unit-299-/u);
  assert.match(checkpoint.detail, /pstack_status.*pstack_\*_read/u);
  const full = await call("pstack_status", {});
  assert.equal(full.state.units.length, 300);
  assert.equal(full.summary.openGateIds.length, 300);
  assert.equal(Object.keys(full.summary.unitStates).length, 300);
});
