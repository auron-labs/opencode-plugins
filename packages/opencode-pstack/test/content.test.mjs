import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent } from "../dist/content.js";

const vendor = fileURLToPath(new URL("../vendor/pstack/", import.meta.url));

test("all upstream skills, agents, and playbooks are available through native content", async () => {
  const content = await loadContent();
  const upstreamDirectories = await readdir(nodePath.join(vendor, "skills"));
  const upstreamSkills = upstreamDirectories.toSorted();
  assert.deepEqual(
    content.skills.map(({ name }) => name).toSorted(),
    upstreamSkills
  );
  assert.equal(
    new Set(content.commands.map(({ name }) => name)).size,
    content.commands.length
  );
  for (const skill of content.skills) {
    assert.ok(nodePath.isAbsolute(skill.path));
    assert.ok(skill.description.trim());
    assert.ok(
      content.commands.some(({ name }) => name === `pstack-${skill.name}`)
    );
  }
  const playbooks = await readdir(
    nodePath.join(vendor, "skills/poteto-mode/playbooks")
  );
  for (const playbook of playbooks) {
    assert.ok(
      content.commands.some(
        ({ name }) => name === `pstack-${playbook.slice(0, -3)}`
      )
    );
  }
  assert.equal(
    content.agents.find(({ name }) => name === "pstack")?.mode,
    "primary"
  );
  for (const name of [
    "poteto-agent",
    "comment-sicko",
    "pstack-explorer",
    "pstack-judgment",
    "pstack-reviewer",
    "pstack-verifier",
  ]) {
    assert.equal(
      content.agents.find((agent) => agent.name === name)?.mode,
      "subagent"
    );
  }
  assert.equal(
    content.commands.find(({ name }) => name === "pstack")?.agent,
    "pstack"
  );
  assert.ok(
    content.commands.every(({ template }) => template.includes("$ARGUMENTS"))
  );
});

test("adapted references remain bounded to inventoried Markdown and never expose scripts or arbitrary paths", async () => {
  const content = await loadContent();
  await Promise.all(
    [
      "../../../../etc/passwd",
      "/etc/passwd",
      "skills/poteto-mode/../poteto-mode/SKILL.md",
      "skills/poteto-mode/scripts/orch/orch.ts",
      "skills/poteto-mode/SKILL.md\0",
      "README.md",
    ].map((path) =>
      assert.rejects(content.readReference(path), /Unknown bundled/u)
    )
  );
  const main = await content.readReference("skills/poteto-mode/SKILL.md");
  assert.match(
    main,
    /pstack_reference path "skills\/poteto-mode\/playbooks\/prototype\.md"/u
  );
  assert.match(main, /pstack-prototype|Prototype playbook/u);
  assert.match(main, /Do not read the original vendor files directly/u);
  const resources = await Promise.all(
    content.references.map(async (path) => ({
      path,
      text: await content.readReference(path),
    }))
  );
  for (const { path, text } of resources) {
    for (const [, target] of text.matchAll(
      /pstack_reference path "(?<capture1>[^"]+)"/gu
    )) {
      assert.ok(
        content.references.includes(target),
        `${path} links to unregistered ${target}`
      );
    }
  }
});

test("Cursor runtime primitives and helper scripts are translated while workflow evidence requirements survive", async () => {
  const content = await loadContent();
  const resources = await Promise.all(
    content.references.map(async (path) => ({
      path,
      text: await content.readReference(path),
    }))
  );
  for (const { path, text } of resources) {
    assert.doesNotMatch(
      text,
      /\.cursor\/|pstack-models\.mdc|grok-4\.7|claude-opus-5-5|readonly:\s*(?:true|false)|run_in_background:|environment:\s*"(?:cloud|local)"|cloud_base_branch|subagent_type:\s*generalPurpose|scripts\/(?:orch|watch-pr|log\.sh|worktree-audit|check-plan)|git show origin\/main:pstack\/skills|\/loop\b/u,
      path
    );
    assert.match(
      text,
      /Models are bound to these agent names at plugin startup/u,
      path
    );
  }
  const plan = await content.readReference(
    "skills/poteto-mode/playbooks/multi-phase-plan.md"
  );
  assert.match(plan, /The live block is mandatory/u);
  assert.match(plan, /Regression lane against trunk/u);
  assert.match(plan, /Do not claim a ratio between unlike scenarios/u);
  const arena = await content.readReference("skills/arena/SKILL.md");
  assert.match(arena, /Read every candidate end to end/u);
  assert.match(arena, /3-6 concrete gradeable criteria/u);
  assert.match(arena, /its own output location/u);
  const orchestrate = await content.readReference(
    "skills/poteto-mode/playbooks/orchestrate.md"
  );
  assert.match(orchestrate, /pstack_inbox action push/u);
  assert.match(orchestrate, /pstack_ledger_read action check/u);
  assert.match(orchestrate, /A new head SHA voids the row/u);
  assert.match(orchestrate, /A frontier snapshot is not live forge authority/u);
  const trail = await content.readReference(
    "skills/show-me-your-work/SKILL.md"
  );
  assert.match(trail, /pstack_decision action append/u);
  assert.match(trail, /pstack_decision_read action list/u);
  assert.match(trail, /superseding decision/u);
});

test("setup preserves user startup configuration and uses native agents for model diversity", async () => {
  const content = await loadContent();
  const setup = content.skills.find(
    ({ name }) => name === "setup-pstack"
  )?.content;
  assert.match(setup, /~\/\.config\/opencode\/pstack\.json/u);
  assert.match(setup, /never overwrites startup configuration/u);
  assert.match(setup, /restarting OpenCode applies it/u);
  assert.match(setup, /pstack-reviewer/u);
  assert.match(setup, /pstack-verifier/u);
  assert.doesNotMatch(
    setup,
    /alwaysApply|Overwrite the whole file|Enumerate the model slugs/u
  );
  assert.match(
    content.agents.find(({ name }) => name === "poteto-agent")?.system,
    /native skill tool/u
  );
  assert.match(
    content.agents.find(({ name }) => name === "comment-sicko")?.system,
    /MUST KILL/u
  );
});

test("delegation input matches the installed OpenCode v2 subagent schema", async () => {
  const modulePath = import.meta.resolve("@opencode/core/tool/plugin/subagent");
  const declarationPath = modulePath
    .replace("/dist/tool/", "/dist/types/tool/")
    .replace(/\.js$/u, ".d.ts");
  const declaration = await readFile(new URL(declarationPath), "utf-8");
  const input = declaration
    .split("export declare const Input:")[1]
    ?.split("export declare const Output:")[0];
  assert.ok(
    input,
    "installed core must expose the native subagent input schema"
  );
  const required = [
    ...input.matchAll(/readonly (?<field>\w+): Schema\.String;/gu),
  ]
    .map((match) => match.groups.field)
    .toSorted();
  const content = await loadContent();
  const system = content.agents.find(({ name }) => name === "pstack")?.system;
  const example =
    /Example native subagent input:\n```json\n(?<input>[^\n]+)\n```/u.exec(
      system
    )?.groups.input;
  assert.ok(
    example,
    "adapter must demonstrate an executable native delegation input"
  );
  const parsed = JSON.parse(example);
  assert.deepEqual(Object.keys(parsed).toSorted(), required);
  assert.match(declaration, /export declare const name = "subagent"/u);
  assert.match(input, /readonly background: Schema\.optionalKey/u);
  assert.match(system, /native subagent tool/u);
  assert.match(
    system,
    /omit the optional model override unless the user explicitly requests/u
  );
  const resources = await Promise.all(
    content.references.map(async (path) => ({
      path,
      text: await content.readReference(path),
    }))
  );
  for (const { path, text } of resources) {
    assert.doesNotMatch(
      text,
      /subagent_type|native task tool|cannot select a model/u,
      path
    );
  }
});

test("frontmatter parser handles folded descriptions and fails on upstream metadata drift", async () => {
  const content = await loadContent();
  const ui = content.skills.find(({ name }) => name === "make-bot-ui");
  assert.match(ui?.description, /Use when building a custom UI.*Grok Bot/su);
  const directory = await mkdtemp(nodePath.join(tmpdir(), "pstack-metadata-"));
  try {
    const original = await readFile(
      nodePath.join(vendor, "skills/bro/SKILL.md"),
      "utf-8"
    );
    await Promise.all(
      [
        "unknown-platform-field: true\nname: bro",
        "name: bro\nname: duplicate",
        "disable-model-invocation: definitely\nname: bro",
      ].map(async (replacement, index) => {
        const fixture = nodePath.join(directory, String(index));
        await cp(vendor, fixture, { recursive: true });
        await writeFile(
          nodePath.join(fixture, "skills/bro/SKILL.md"),
          original.replace("name: bro", replacement)
        );
        await assert.rejects(
          loadContent(fixture),
          /Unsupported pstack metadata|Invalid pstack frontmatter/u
        );
      })
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
