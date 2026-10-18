import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Model } from "@opencode/plugin";
import { z } from "zod";

const configSchema = z.strictObject({
  models: z.record(z.string(), z.string().trim().min(1)).default({}),
});

export interface PstackConfig {
  path: string;
  models: ReadonlyMap<string, Model.Ref>;
}

const defaultConfigPath = (): string =>
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
    "opencode",
    "pstack.json"
  );

export const loadConfig = async (
  agentNames: ReadonlySet<string>,
  configPath = defaultConfigPath()
): Promise<PstackConfig> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf-8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { models: new Map(), path: configPath };
    }
    throw new Error(
      `opencode-pstack: cannot read configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `opencode-pstack: invalid configuration ${configPath}: ${parsed.error.message}`
    );
  }
  const models = new Map<string, Model.Ref>();
  for (const [name, reference] of Object.entries(parsed.data.models)) {
    if (!agentNames.has(name)) {
      throw new Error(
        `opencode-pstack: unknown agent "${name}" in ${configPath}`
      );
    }
    try {
      if (/\s/u.test(reference)) {
        throw new Error("model references cannot contain whitespace");
      }
      models.set(name, Model.Ref.parse(reference));
    } catch (error) {
      throw new Error(
        `opencode-pstack: invalid model for "${name}" in ${configPath}; expected provider/model or provider/model#variant`,
        { cause: error }
      );
    }
  }
  return { models, path: configPath };
};
