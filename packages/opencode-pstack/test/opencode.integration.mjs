import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LLMock } from "@copilotkit/aimock";

const exec = promisify(execFile);
const binary = process.env.OPENCODE_BIN ?? "opencode";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const statePath = ".opencode/pstack/state.json";

const fixture = async (t, permission = "allow") => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-aimock-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const mock = new LLMock({ host: "127.0.0.1", port: 0, strict: true });
  await mock.start();
  t.after(() => mock.stop());
  const project = path.join(root, "project");
  const config = path.join(root, "config", "opencode");
  const probe = path.join(root, "provider");
  await Promise.all(
    [project, config, probe].map((directory) =>
      mkdir(directory, { recursive: true })
    )
  );
  const provider = await readFile(
    new URL("fixtures/aimock-provider.mjs", import.meta.url),
    "utf-8"
  );
  await writeFile(path.join(probe, "index.js"), provider);
  await writeFile(
    path.join(probe, "package.json"),
    JSON.stringify({ main: "index.js", type: "module" })
  );
  await writeFile(
    path.join(config, "opencode.json"),
    JSON.stringify({
      formatter: false,
      lsp: false,
      model: "pstack-test/fixture",
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "pstack_status", effect: "allow", resource: "*" },
        { action: "pstack_write", effect: "allow", resource: "*" },
        {
          action: "pstack_write",
          effect: permission,
          resource: path.join(project, statePath),
        },
      ],
      plugins: [
        { package: path.join(packageRoot, "dist") },
        { options: { baseURL: `${mock.url}/v1` }, package: probe },
      ],
    })
  );
  const run = async (message) => {
    const running = exec(
      binary,
      [
        "run",
        "--standalone",
        "--print-logs",
        "--agent",
        "pstack",
        "--model",
        "pstack-test/fixture",
        "--title",
        "PStack integration",
        message,
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: root,
          INIT_CWD: project,
          OPENCODE_CONFIG: path.join(config, "opencode.json"),
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          PWD: project,
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
        },
        maxBuffer: 2_000_000,
        timeout: 45_000,
      }
    );
    running.child.stdin.end();
    const { stdout, stderr } = await running;
    assert.match(stdout, /PSTACK_DONE/u, stdout + stderr);
    const requests = mock.getRequests().filter((entry) => entry.body?.messages);
    assert.ok(requests.length > 0, stdout + stderr);
    assert.ok(
      requests.every(
        (entry) => entry.response.status === 200 && entry.response.fixture
      ),
      JSON.stringify(requests)
    );
    return requests.map((entry) => entry.body);
  };
  return { mock, project, run };
};

const toolCall = (name, args) => ({
  toolCalls: [{ arguments: args, name }],
});

test(
  "real OpenCode executes pstack tools through aimock and restores durable state on restart",
  { timeout: 100_000 },
  async (t) => {
    const { mock, project, run } = await fixture(t);
    mock.on(
      { hasToolResult: false, userMessage: "create-unit" },
      toolCall("pstack_unit", {
        action: "add",
        id: "integration",
        track: "feature",
      })
    );
    mock.on(
      { hasToolResult: true, userMessage: "create-unit" },
      { content: "PSTACK_DONE" }
    );
    const requests = await run("create-unit");
    assert.ok(
      requests[0].tools.some((tool) => tool.function.name === "pstack_unit")
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /OpenCode pstack adapter/u
    );
    assert.match(
      JSON.stringify(
        requests.at(-1).messages.filter((message) => message.role === "tool")
      ),
      /integration/u
    );
    const saved = await readFile(path.join(project, statePath), "utf-8");
    const state = JSON.parse(saved);
    assert.equal(state.units[0].id, "integration");

    mock.clearRequests();
    mock.on(
      { hasToolResult: false, userMessage: "read-state" },
      toolCall("pstack_status", {})
    );
    mock.on(
      { hasToolResult: true, userMessage: "read-state" },
      { content: "PSTACK_DONE" }
    );
    const restored = await run("read-state");
    const system = restored[0].messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.match(system, /Abbreviated checkpoint/u);
    assert.match(system, /"id":"integration"/u);
    assert.match(
      JSON.stringify(
        restored.at(-1).messages.filter((message) => message.role === "tool")
      ),
      /integration/u
    );
    assert.equal(await readFile(path.join(project, statePath), "utf-8"), saved);
  }
);

test(
  "real OpenCode denies pstack writes without creating state",
  { timeout: 55_000 },
  async (t) => {
    const { mock, project, run } = await fixture(t, "deny");
    mock.on(
      { hasToolResult: false, userMessage: "denied-write" },
      toolCall("pstack_unit", { action: "add", id: "denied", track: "feature" })
    );
    mock.on(
      { hasToolResult: true, userMessage: "denied-write" },
      { content: "PSTACK_DONE" }
    );
    const requests = await run("denied-write");
    assert.ok(
      requests[0].tools.some((tool) => tool.function.name === "pstack_unit")
    );
    assert.match(
      JSON.stringify(
        requests.at(-1).messages.filter((message) => message.role === "tool")
      ),
      /Permission denied/u
    );
    await assert.rejects(readFile(path.join(project, statePath)), {
      code: "ENOENT",
    });
  }
);
