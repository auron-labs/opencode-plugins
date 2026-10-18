import { realpath } from "node:fs/promises";
import path from "node:path";

import type { Permission } from "@opencode/core/permission";
import { Agent, Plugin, Skill } from "@opencode/plugin/effect";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Context, Effect, Option } from "effect";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { loadContent } from "./content.js";
import { buildStateTools } from "./state-tools.js";
import { loadCheckpoint, STATE_RELATIVE_PATH } from "./state.js";

// Effect service identity is its key. The host provides this service while tools execute;
// importing its backend implementation would load modules unavailable to plugin sandboxes.
const permissionService = Context.Service<typeof Permission.Service.Service>(
  "@opencode/Permission"
);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Effect failure channels contain arbitrary rejected values at this boundary.
const failure = (error: unknown): ToolError =>
  new ToolError({
    message: error instanceof Error ? error.message : String(error),
  });

export default Plugin.define({
  effect: (ctx) =>
    Effect.gen(function* setupPstack() {
      const directory = yield* Effect.promise(() =>
        realpath(ctx.location.directory)
      );
      const content = yield* Effect.promise(() => loadContent());
      const agentNames = new Set(content.agents.map((agent) => agent.name));
      const config = yield* Effect.promise(() => loadConfig(agentNames));

      yield* ctx.agent.transform((editor) => {
        for (const definition of content.agents) {
          const existing = editor.get(definition.name);
          const model = config.models.get(definition.name);
          if (existing && !model) {
            continue;
          }
          editor.update(definition.name, (agent) => {
            if (!existing) {
              agent.description = definition.description;
              agent.system = definition.system;
              agent.mode = definition.mode;
            }
            if (model) {
              agent.model = { ...model };
            }
          });
        }
      });

      yield* ctx.skill.transform((editor) => {
        for (const definition of content.skills) {
          if (editor.get(definition.name)) {
            continue;
          }
          editor.add({
            content: definition.content,
            description: definition.description,
            id: Skill.ID.make(definition.name),
            name: Skill.Name.make(definition.name),
            path: Skill.Info.fields.path.make(definition.path),
          });
        }
      });

      const commands = new Set(
        (yield* ctx.command.list()).data.map((command) => command.name)
      );
      yield* ctx.command.transform((editor) => {
        for (const definition of content.commands) {
          if (commands.has(definition.name)) {
            continue;
          }
          editor.add({
            description: definition.description,
            execute: ({ sessionID, prompt, delivery }) =>
              Effect.gen(function* executeCommand() {
                const agentID = Agent.ID.make(definition.agent ?? "pstack");
                const commandAgent = (yield* ctx.agent.get({ agentID })).data;
                yield* ctx.session.switchAgent({
                  agent: agentID,
                  sessionID,
                });
                if (commandAgent?.model) {
                  yield* ctx.session.switchModel({
                    model: commandAgent.model,
                    sessionID,
                  });
                }
                yield* ctx.session.prompt({
                  ...prompt,
                  delivery,
                  sessionID,
                  text: definition.template.replaceAll(
                    "$ARGUMENTS",
                    () => prompt.text
                  ),
                });
              }),
            name: definition.name,
          });
        }
      });

      // Native Effect executors assert permissions before entering these Promise tools.
      const definitions = buildStateTools(directory, () => Promise.resolve());
      yield* ctx.tool.transform((editor) => {
        for (const definition of definitions) {
          if (editor.get(definition.name)) {
            continue;
          }
          editor.add({
            ...definition,
            execute: (input, context) =>
              Effect.gen(function* executeStateTool() {
                const session = yield* ctx.session
                  .get({ sessionID: context.sessionID })
                  .pipe(Effect.mapError(failure));
                const sessionDirectory = yield* Effect.tryPromise({
                  catch: failure,
                  try: () => realpath(session.location.directory),
                });
                if (sessionDirectory !== directory) {
                  return yield* Effect.fail(
                    failure(
                      "PStack session directory changed; reopen the project before using its state tools"
                    )
                  );
                }
                if (definition.options?.permission === "pstack_write") {
                  const permission =
                    yield* Effect.serviceOption(permissionService);
                  if (Option.isNone(permission)) {
                    return yield* Effect.fail(
                      failure(
                        new Error("OpenCode permission service unavailable")
                      )
                    );
                  }
                  yield* permission.value
                    .assert({
                      action: "pstack_write",
                      agent: context.agent,
                      metadata: { description: definition.description },
                      resources: [path.join(directory, STATE_RELATIVE_PATH)],
                      sessionID: context.sessionID,
                      source: {
                        id: context.id,
                        messageID: context.messageID,
                        type: "tool",
                      },
                    })
                    .pipe(Effect.mapError(failure));
                }
                const runtime = yield* Effect.context();
                return yield* Effect.tryPromise({
                  catch: failure,
                  try: (signal) =>
                    definition.execute(input, {
                      ...context,
                      progress: (update) =>
                        Effect.runPromiseWith(runtime)(
                          context.progress(update),
                          { signal }
                        ),
                      signal,
                    }),
                });
              }),
          });
        }
        if (!editor.get("pstack_reference")) {
          editor.add({
            description:
              "Load a bundled PStack reference by its registered relative path.",
            execute: ({ path: reference }) =>
              Effect.tryPromise({
                catch: failure,
                try: async () => ({
                  content: await content.readReference(reference),
                }),
              }),
            input: z.object({ path: z.string().min(1) }),
            name: "pstack_reference",
            options: { codemode: false },
          });
        }
      });

      for (const hook of ["context", "compaction"] as const) {
        yield* ctx.session.hook(hook, (event) =>
          Effect.gen(function* restoreCheckpoint() {
            if (!agentNames.has(event.agent)) {
              return;
            }
            const session = yield* ctx.session.get({
              sessionID: event.sessionID,
            });
            const sessionDirectory = yield* Effect.promise(() =>
              realpath(session.location.directory)
            );
            if (sessionDirectory !== directory) {
              return;
            }
            const checkpoint = yield* Effect.tryPromise({
              catch: failure,
              try: () => loadCheckpoint(directory),
            }).pipe(
              Effect.match({
                onFailure: (error) =>
                  `PStack state is unavailable: ${error.message}. Preserve the existing state file and explain the repair needed before continuing workflow mutations.`,
                onSuccess: (value) => value,
              })
            );
            if (checkpoint) {
              event.system.push({ text: checkpoint, type: "text" });
            }
          }).pipe(Effect.orDie)
        );
      }
    }).pipe(Effect.orDie),
  id: "opencode-pstack",
});
