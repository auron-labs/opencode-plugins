import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../dist/config.js";

const agents = new Set(["pstack", "poteto-agent", "pstack-reviewer"]);

const fixture = async (t, value) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pstack-config-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, "pstack.json");
  if (value !== undefined) {
    await writeFile(file, JSON.stringify(value));
  }
  return file;
};

test("missing startup configuration leaves agents on their host model", async (t) => {
  const config = await loadConfig(agents, await fixture(t));
  assert.equal(config.models.size, 0);
});

test("malformed JSON fails startup with the configuration path", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "{");
  await assert.rejects(loadConfig(agents, file), (error) =>
    error.message.includes(file)
  );
});

test("startup model bindings preserve model path segments and variants", async (t) => {
  const file = await fixture(t, {
    models: {
      "poteto-agent": "openrouter/provider/model#high",
      pstack: "openai/gpt-5",
    },
  });
  const config = await loadConfig(agents, file);
  assert.deepEqual(config.models.get("pstack"), {
    id: "gpt-5",
    providerID: "openai",
  });
  assert.deepEqual(config.models.get("poteto-agent"), {
    id: "provider/model",
    providerID: "openrouter",
    variant: "high",
  });
});

test("invalid startup configuration reports its path and rejects unknown agents", async (t) => {
  const invalid = [
    "invalid-json-marker",
    { models: { absent: "openai/model" } },
    { models: { pstack: "model" } },
    { models: { pstack: "/model" } },
    { models: { pstack: "provider/" } },
    { models: { pstack: "provider/model#" } },
    { models: { pstack: "provider/model#one#two" } },
    { models: { pstack: "provider/model variant" } },
    { models: { pstack: 3 } },
    { unknown: true },
    null,
  ];
  await Promise.all(
    invalid.map(async (value) => {
      const file = await fixture(t, value);
      await assert.rejects(loadConfig(agents, file), (error) =>
        error.message.includes(file)
      );
    })
  );
});
