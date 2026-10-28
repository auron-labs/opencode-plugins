import { loadContent } from "../src/content.ts";

const content = await loadContent();
const references = Object.fromEntries(
  await Promise.all(
    content.references.map(async (path) => [
      path,
      await content.readReference(path),
    ])
  )
);

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  format: "esm",
  naming: "opencode-pstack.js",
  outdir: "./dist",
  packages: "bundle",
  plugins: [
    {
      name: "embed-pstack-content",
      setup(build) {
        build.onLoad({ filter: /[/\\]content\.ts$/u }, () => ({
          contents: `
            const content = ${JSON.stringify({
              agents: content.agents,
              commands: content.commands,
              references: content.references,
              skills: content.skills,
            })};
            const references = new Map(
              Object.entries(${JSON.stringify(references)})
            );

            export async function loadContent() {
              return {
                ...content,
                async readReference(path) {
                  if (!references.has(path)) {
                    throw new Error("Unknown bundled pstack Markdown path.");
                  }
                  return references.get(path);
                },
              };
            }
          `,
          loader: "js",
        }));
      },
    },
  ],
  splitting: false,
  target: "node",
});

if (!result.success) {
  throw new AggregateError(result.logs, "Standalone build failed");
}

console.log("Built dist/opencode-pstack.js");
