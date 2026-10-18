import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

// Keep the real provider transport; remove external providers so every model
// request, including host-generated titles, can only reach the local aimock.
export default Plugin.define({
  effect: (ctx) =>
    ctx.provider
      .transform((editor) => {
        const template = editor.get("openai");
        const model = template.models.get("gpt-4o");
        for (const record of editor.list()) {
          editor.remove(record.provider.id);
        }
        editor.add({
          info: {
            ...template.provider,
            activation: "enabled",
            canonical: undefined,
            id: "pstack-test",
            integrationID: undefined,
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { apiKey: "offline", baseURL: ctx.options.baseURL },
          },
          models: [{ ...model, id: "fixture", providerID: "pstack-test" }],
        });
      })
      .pipe(Effect.asVoid),
  id: "pstack-aimock-provider",
});
