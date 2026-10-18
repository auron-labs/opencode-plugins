/* oxlint-disable eslint/no-await-in-loop -- Workflow cases run serially because each replaces the same captured log. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

const workflow = parse(
  await readFile(
    new URL("../../../.github/workflows/sync-pstack.yaml", import.meta.url),
    "utf-8"
  )
);

test("remote verification and lint failures reach the sync repair gate and its log", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-workflow-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "packages/opencode-pstack");
  const bin = path.join(root, "bin");
  await mkdir(directory, { recursive: true });
  await mkdir(bin);
  for (const command of ["bun", "git", "mise"]) {
    await writeFile(
      path.join(bin, command),
      `#!/bin/bash
echo "${command} $*"
if [[ "${command} $*" == "$FAIL_COMMAND" ]]; then exit 1; fi
`,
      { mode: 0o755 }
    );
  }
  const update = workflow.jobs.sync.steps.find((step) => step.id === "update");
  assert.equal(update["continue-on-error"], true);
  assert.match(
    workflow.jobs.sync.outputs.failed,
    /steps\.update\.outcome == 'failure'/u
  );
  for (const failure of [
    "bun run sync:check --remote",
    "mise exec -- hk check --check --no-fail-fast --staged",
    "",
  ]) {
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", update.run], {
      cwd: directory,
      encoding: "utf-8",
      env: {
        ...process.env,
        FAIL_COMMAND: failure,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: root,
      },
    });
    assert.equal(result.status, failure ? 1 : 0, result.stderr);
    const log = await readFile(
      path.join(root, "pstack-sync/sync.log"),
      "utf-8"
    );
    assert.ok(log.includes(failure || "bun run check:pack"));
  }
});
