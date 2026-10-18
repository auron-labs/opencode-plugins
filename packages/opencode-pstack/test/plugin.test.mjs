/* oxlint-disable promise/prefer-await-to-callbacks -- The host transform contract registers synchronous editor callbacks. */
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { Permission } from "@opencode/core/permission";
import { Agent } from "@opencode/plugin";
import { Effect } from "effect";

import { loadContent } from "../dist/content.js";
import plugin from "../dist/index.js";

test("plugin loads when the host blocks backend module imports", async () => {
  const source = `
    import { registerHooks } from "node:module";
    import { parentPort } from "node:worker_threads";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith("@opencode/core")) {
          throw new Error("Backend module imports are unavailable to plugins");
        }
        return nextResolve(specifier, context);
      }
    });
    const plugin = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    parentPort.postMessage(plugin.default.id);
  `;
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(source)}`)
  );
  try {
    const [id] = await once(worker, "message");
    assert.equal(id, "opencode-pstack");
  } finally {
    await worker.terminate();
  }
});

const fixture = async (t, config) => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-plugin-"));
  const directory = path.join(root, "project");
  const configRoot = path.join(root, "config");
  await mkdir(directory);
  await mkdir(path.join(configRoot, "opencode"), { recursive: true });
  if (config) {
    await writeFile(
      path.join(configRoot, "opencode/pstack.json"),
      JSON.stringify(config)
    );
  }
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  t.after(async () => {
    if (old === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = old;
    }
    await rm(root, { force: true, recursive: true });
  });
  return { directory, root };
};

const harness = (directory, initial = {}) => {
  const agents = new Map(Object.entries(initial.agents ?? {}));
  const commands = new Map(Object.entries(initial.commands ?? {}));
  const skills = new Map(Object.entries(initial.skills ?? {}));
  const tools = new Map(Object.entries(initial.tools ?? {}));
  const hooks = new Map();
  const calls = [];
  const session = {
    agent: "build",
    location: { directory },
    model: initial.model ?? { id: "model-a", providerID: "provider-a" },
  };
  const registration = { dispose: Effect.void };
  const ctx = {
    agent: {
      get: ({ agentID }) => Effect.succeed({ data: agents.get(agentID) }),
      transform: (edit) =>
        Effect.sync(() => {
          edit({
            get: (name) => agents.get(name),
            update: (name, update) => {
              const agent =
                agents.get(name) ?? Agent.Info.default(Agent.ID.make(name));
              update(agent);
              agents.set(name, agent);
            },
          });
          return registration;
        }),
    },
    command: {
      list: () =>
        Effect.succeed({ data: [...commands].map(([name]) => ({ name })) }),
      transform: (edit) =>
        Effect.sync(() => {
          edit({ add: (command) => commands.set(command.name, command) });
          return registration;
        }),
    },
    location: { directory },
    options: {},
    session: {
      get: () => Effect.succeed(session),
      hook: (name, hook) =>
        Effect.sync(() => {
          hooks.set(name, hook);
          return registration;
        }),
      prompt: (input) =>
        Effect.sync(() => {
          calls.push({ input, method: "prompt" });
        }),
      switchAgent: (input) =>
        Effect.sync(() => {
          session.agent = input.agent;
          calls.push({ input, method: "switchAgent" });
        }),
      switchModel: (input) =>
        Effect.sync(() => {
          session.model = input.model;
          calls.push({ input, method: "switchModel" });
        }),
    },
    skill: {
      transform: (edit) =>
        Effect.sync(() => {
          edit({
            add: (skill) => skills.set(skill.id, skill),
            get: (name) => skills.get(name),
          });
          return registration;
        }),
    },
    tool: {
      transform: (edit) =>
        Effect.sync(() => {
          edit({
            add: (tool) => tools.set(tool.name, tool),
            get: (name) => tools.get(name),
          });
          return registration;
        }),
    },
  };
  return { agents, calls, commands, ctx, hooks, session, skills, tools };
};

const toolContext = {
  agent: "pstack",
  id: "call-one",
  messageID: "message-one",
  progress: () => Effect.void,
  sessionID: "session-one",
};

test("v2 plugin registers bundled agents, skills, commands and typed native tools without creating project files", async (t) => {
  const { directory } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  assert.equal(plugin.id, "opencode-pstack");
  assert.equal(host.agents.get("pstack").mode, "primary");
  assert.equal(host.agents.get("poteto-agent").mode, "subagent");
  assert.equal(host.agents.get("poteto-agent").model, undefined);
  assert.ok(host.skills.size > 10);
  assert.ok(host.commands.size > 10);
  assert.ok(host.tools.has("pstack_reference"));
  assert.ok(
    host.tools
      .get("pstack_unit")
      .input.safeParse({ action: "add", id: "unit", track: "feature" }).success
  );
  assert.ok(
    !host.tools
      .get("pstack_unit")
      .input.safeParse({ action: "add", id: "../escape", track: "feature" })
      .success
  );
  await assert.rejects(access(path.join(directory, ".opencode")), {
    code: "ENOENT",
  });
});

test("explicit startup bindings update only the model on existing user agents; registrations preserve user entries", async (t) => {
  const { directory } = await fixture(t, {
    models: { pstack: "openai/model#high" },
  });
  const content = await loadContent();
  const commandName = content.commands[0].name;
  const skillName = content.skills[0].name;
  const existing = {
    ...Agent.Info.default(Agent.ID.make("pstack")),
    model: { id: "model", providerID: "old" },
    system: "user instructions",
  };
  const command = {
    execute: () => assert.fail("user command executed"),
    name: commandName,
  };
  const skill = { content: "user skill", id: skillName };
  const tool = {
    execute: () => assert.fail("user tool executed"),
    name: "pstack_reference",
  };
  const host = harness(directory, {
    agents: { pstack: existing },
    commands: { [commandName]: command },
    skills: { [skillName]: skill },
    tools: { pstack_reference: tool },
  });
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  assert.equal(host.agents.get("pstack"), existing);
  assert.equal(existing.system, "user instructions");
  assert.deepEqual(existing.model, {
    id: "model",
    providerID: "openai",
    variant: "high",
  });
  assert.equal(host.commands.get(commandName), command);
  assert.equal(host.skills.get(skillName), skill);
  assert.equal(host.tools.get("pstack_reference"), tool);
});

test("command routing retains attachments, delivery and literal user arguments", async (t) => {
  const { directory } = await fixture(t);
  const content = await loadContent();
  const definition = content.commands.find((entry) =>
    entry.template.includes("$ARGUMENTS")
  );
  assert.ok(definition);
  const host = harness(directory);
  const originalModel = host.session.model;
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const prompt = {
    attachments: [{ type: "file", uri: "file:///brief" }],
    text: "implement $& and $ARGUMENTS literally",
  };
  await Effect.runPromise(
    host.commands
      .get(definition.name)
      .execute({ delivery: "queue", prompt, sessionID: "session-one" })
  );
  assert.equal(host.calls[0].input.agent, definition.agent ?? "pstack");
  const invocation = host.calls[1].input;
  assert.equal(invocation.attachments, prompt.attachments);
  assert.equal(invocation.delivery, "queue");
  assert.ok(invocation.text.includes(prompt.text));
  assert.equal(host.session.model, originalModel);
  assert.ok(host.calls.every((call) => call.method !== "switchModel"));
});

test("pstack command applies its configured agent model before submitting the prompt", async (t) => {
  const { directory } = await fixture(t, {
    models: { pstack: "provider-b/model-b#high" },
  });
  const host = harness(directory);
  assert.deepEqual(host.session.model, {
    id: "model-a",
    providerID: "provider-a",
  });
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const attachments = [{ type: "file", uri: "file:///request" }];
  await Effect.runPromise(
    host.commands.get("pstack").execute({
      delivery: "queue",
      prompt: { attachments, text: "Implement caching" },
      sessionID: "session-one",
    })
  );
  assert.equal(host.session.agent, "pstack");
  assert.deepEqual(host.session.model, {
    id: "model-b",
    providerID: "provider-b",
    variant: "high",
  });
  assert.deepEqual(
    host.calls.map((call) => call.method),
    ["switchAgent", "switchModel", "prompt"]
  );
  assert.equal(host.calls[2].input.attachments, attachments);
  assert.equal(host.calls[2].input.delivery, "queue");
  assert.match(host.calls[2].input.text, /Implement caching/u);
});

test("command routing resolves the effective user agent model at invocation time", async (t) => {
  const { directory } = await fixture(t);
  const existing = {
    ...Agent.Info.default(Agent.ID.make("pstack")),
    model: { id: "user-model", providerID: "user-provider" },
  };
  const host = harness(directory, { agents: { pstack: existing } });
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  // A later host transform can change the effective model after plugin registration.
  existing.model = { id: "effective-model", providerID: "effective-provider" };
  await Effect.runPromise(
    host.commands.get("pstack").execute({
      delivery: "queue",
      prompt: { text: "Review the design" },
      sessionID: "session-one",
    })
  );
  assert.deepEqual(host.session.model, existing.model);
  assert.deepEqual(host.calls[1].input, {
    model: existing.model,
    sessionID: "session-one",
  });
});

test("native mutation permissions fail closed and approved writes persist with the current session identity", async (t) => {
  const { directory } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const unit = host.tools.get("pstack_unit");
  const args = { action: "add", id: "one", track: "feature" };
  await assert.rejects(
    Effect.runPromise(unit.execute(args, toolContext)),
    /permission service unavailable/u
  );
  await assert.rejects(access(path.join(directory, ".opencode")), {
    code: "ENOENT",
  });
  const requests = [];
  const permission = {
    assert: (request) =>
      Effect.sync(() => {
        requests.push(request);
      }),
  };
  await Effect.runPromise(
    unit
      .execute(args, toolContext)
      .pipe(Effect.provideService(Permission.Service, permission))
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "pstack_write");
  assert.equal(requests[0].sessionID, toolContext.sessionID);
  assert.equal(requests[0].agent, toolContext.agent);
  assert.deepEqual(requests[0].source, {
    id: "call-one",
    messageID: "message-one",
    type: "tool",
  });
  const state = JSON.parse(
    await readFile(path.join(directory, ".opencode/pstack/state.json"), "utf-8")
  );
  assert.equal(state.units[0].id, "one");
  await assert.rejects(
    Effect.runPromise(
      unit.execute({ ...args, id: "denied" }, toolContext).pipe(
        Effect.provideService(Permission.Service, {
          assert: () => Effect.fail(new Error("denied by host")),
        })
      )
    ),
    /denied by host/u
  );
  const after = JSON.parse(
    await readFile(path.join(directory, ".opencode/pstack/state.json"), "utf-8")
  );
  assert.equal(after.units.length, 1);
});

test("reads work without mutation permissions and session moves cannot cross project state boundaries", async (t) => {
  const { directory, root } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const result = await Effect.runPromise(
    host.tools.get("pstack_status").execute({}, toolContext)
  );
  assert.ok(JSON.parse(result.content));
  host.ctx.session.get = () =>
    Effect.succeed({ location: { directory: root } });
  await assert.rejects(
    Effect.runPromise(host.tools.get("pstack_status").execute({}, toolContext)),
    /session directory changed/u
  );
  const context = { agent: "pstack", sessionID: "session-one", system: [] };
  await Effect.runPromise(host.hooks.get("context")(context));
  assert.equal(context.system.length, 0);
});

test("ask permission waits for a host reply before saving state", async (t) => {
  const { directory } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const asked = Promise.withResolvers();
  let reply;
  const permission = {
    assert: (request) =>
      Effect.callback((resume) => {
        const rule = Permission.evaluate(request.action, request.resources[0], [
          { action: "pstack_write", effect: "ask", resource: "*" },
        ]);
        assert.equal(rule.effect, "ask");
        reply = () => resume(Effect.void);
        asked.resolve();
      }),
  };
  const pending = Effect.runPromise(
    host.tools
      .get("pstack_unit")
      .execute(
        { action: "add", id: "approved-unit", track: "feature" },
        toolContext
      )
      .pipe(Effect.provideService(Permission.Service, permission))
  );
  await asked.promise;
  await assert.rejects(access(path.join(directory, ".opencode")), {
    code: "ENOENT",
  });
  reply();
  await pending;
  const state = JSON.parse(
    await readFile(path.join(directory, ".opencode/pstack/state.json"), "utf-8")
  );
  assert.equal(state.units[0].id, "approved-unit");
});

test("cancelling a pending host approval never creates or saves state", async (t) => {
  const { directory } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const asked = Promise.withResolvers();
  const controller = new AbortController();
  const permission = {
    assert: () =>
      Effect.callback(() => {
        asked.resolve();
      }),
  };
  const pending = Effect.runPromise(
    host.tools
      .get("pstack_unit")
      .execute(
        { action: "add", id: "cancelled-unit", track: "feature" },
        toolContext
      )
      .pipe(Effect.provideService(Permission.Service, permission)),
    { signal: controller.signal }
  );
  await asked.promise;
  const rejected = assert.rejects(pending);
  controller.abort();
  await rejected;
  await assert.rejects(access(path.join(directory, ".opencode")), {
    code: "ENOENT",
  });
});

test("context and compaction hooks restore durable state only for registered PStack agents", async (t) => {
  const { directory } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  await Effect.runPromise(
    host.tools
      .get("pstack_unit")
      .execute(
        { action: "add", id: "resume-unit", track: "feature" },
        toolContext
      )
      .pipe(
        Effect.provideService(Permission.Service, { assert: () => Effect.void })
      )
  );
  await Promise.all(
    ["context", "compaction"].map(async (hook) => {
      const event = { agent: "pstack", sessionID: "session-one", system: [] };
      await Effect.runPromise(host.hooks.get(hook)(event));
      assert.match(event.system[0].text, /resume-unit/u);
      const unrelated = {
        agent: "build",
        sessionID: "session-two",
        system: [],
      };
      await Effect.runPromise(host.hooks.get(hook)(unrelated));
      assert.equal(unrelated.system.length, 0);
    })
  );
});

test("corrupt state leaves the PStack chat available for recovery while state tools reject writes", async (t) => {
  const { directory } = await fixture(t);
  const host = harness(directory);
  await Effect.runPromise(Effect.scoped(plugin.effect(host.ctx)));
  const statePath = path.join(directory, ".opencode/pstack/state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, "broken-state");
  const event = { agent: "pstack", sessionID: "session-one", system: [] };
  await Effect.runPromise(host.hooks.get("context")(event));
  assert.match(event.system[0].text, /state is unavailable/u);
  await assert.rejects(
    Effect.runPromise(
      host.tools
        .get("pstack_unit")
        .execute(
          { action: "add", id: "recovery", track: "feature" },
          toolContext
        )
        .pipe(
          Effect.provideService(Permission.Service, {
            assert: () => Effect.void,
          })
        )
    ),
    /invalid state/u
  );
  assert.equal(await readFile(statePath, "utf-8"), "broken-state");
});
