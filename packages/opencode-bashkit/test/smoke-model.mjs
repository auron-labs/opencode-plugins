// Test-only provider. All external providers are removed; a failed hook only reaches localhost.
import { appendFile, writeFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "bashkit-smoke-model",
  effect: ctx => Effect.gen(function* () {
    yield* ctx.provider.transform(editor => {
      const template = editor.get("openai")
      const model = template.models.get("gpt-4o")
      for (const record of editor.list()) editor.remove(record.provider.id)
      editor.add({
        info: { ...template.provider, id: "bashkit-test", package: "aisdk:@ai-sdk/openai-compatible",
          canonical: undefined, integrationID: undefined, activation: "enabled",
          settings: { baseURL: "http://127.0.0.1:1/v1", apiKey: "offline" } },
        models: [{ ...model, providerID: "bashkit-test", id: "fixture" }],
      })
    })
    yield* ctx.session.hook("context", event => Effect.promise(() => writeFile(ctx.options.toolsFile, JSON.stringify(Object.keys(event.tools)))))
    yield* ctx.tool.hook("execute.after", event => Effect.promise(() => appendFile(ctx.options.resultsFile, JSON.stringify(event) + "\n")))
    yield* ctx.aisdk.hook("language", event => Effect.sync(() => {
      event.language = {
        specificationVersion: "v3", provider: "bashkit-test", modelId: "fixture", supportedUrls: {},
        doGenerate: async () => { throw new Error("stream only") },
        doStream: async input => {
          const count = input.prompt.filter(message => message.role === "tool").reduce((n, message) => n + message.content.length, 0)
          const command = ctx.options.commands[count]
          return { stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            if (command !== undefined) {
              controller.enqueue({ type: "tool-call", toolCallId: `smoke-${count}`, toolName: "shell", input: JSON.stringify({ command }) })
            } else {
              controller.enqueue({ type: "text-start", id: "done" })
              controller.enqueue({ type: "text-delta", id: "done", delta: "done" })
              controller.enqueue({ type: "text-end", id: "done" })
            }
            controller.enqueue({ type: "finish", finishReason: { unified: command === undefined ? "stop" : "tool-calls", raw: "stop" },
              usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } })
            controller.close()
          } }) }
        },
      }
    }))
  }),
})
