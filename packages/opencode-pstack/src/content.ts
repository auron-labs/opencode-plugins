import { readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";
import { z } from "zod";

import { adaptContent, adapterGuide } from "./adapter.js";

const vendorRoot = fileURLToPath(new URL("../vendor/pstack/", import.meta.url));

interface PstackSkill {
  name: string;
  description: string;
  path: string;
  content: string;
}

interface PstackAgent {
  name: string;
  description: string;
  system: string;
  mode: "primary" | "subagent";
}

interface PstackCommand {
  name: string;
  description: string;
  template: string;
  agent?: string;
}

const metadataSchema = z.strictObject({
  color: z.string().optional(),
  description: z.string().trim().min(1),
  "disable-model-invocation": z.boolean().optional(),
  icon: z.string().optional(),
  is_background: z.boolean().optional(),
  name: z.string().trim().min(1),
  paths: z.array(z.string()).optional(),
});

const frontmatter = (source: string, path: string) => {
  const match =
    /^---\r?\n(?<metadata>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]*)$/u.exec(
      source
    );
  if (!match) {
    throw new Error(`Missing pstack frontmatter: ${path}`);
  }
  const document = parseDocument(match.groups?.metadata ?? "", {
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(
      `Invalid pstack frontmatter in ${path}: ${document.errors[0]?.message}`
    );
  }
  const metadata = metadataSchema.safeParse(document.toJS());
  if (!metadata.success) {
    throw new Error(
      `Unsupported pstack metadata in ${path}: ${metadata.error.message}`
    );
  }
  return {
    body: match.groups?.body ?? "",
    description: metadata.data.description,
  };
};

const markdownFiles = async (
  root: string,
  directory: string
): Promise<string[]> => {
  const entries = await readdir(nodePath.join(root, directory), {
    withFileTypes: true,
  });
  const groups = await Promise.all(
    entries
      // ES2022 lacks toSorted; readdir returns an array owned only by this call.
      // eslint-disable-next-line unicorn/no-array-sort
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const path = nodePath.posix.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== "scripts") {
          return markdownFiles(root, path);
        }
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      })
  );
  return groups.flat();
};

const resourceLinks = (
  path: string,
  text: string,
  inventory: Set<string>
): string => {
  const resolve = (target: string): string | undefined => {
    const clean = target.split("#")[0] ?? target;
    const relative = nodePath.posix.normalize(
      nodePath.posix.join(nodePath.posix.dirname(path), clean)
    );
    return inventory.has(relative) ? relative : undefined;
  };
  return text
    .replaceAll(
      /`git show origin\/main:pstack\/(?<capture1>[^`]+)`/gu,
      (_original: string, target: string) =>
        inventory.has(target)
          ? `pstack_reference path "${target}"`
          : "load the named adapted resource through the native skill catalog or pstack_reference"
    )
    .replaceAll(
      /`pstack\/(?<capture1>skills\/[^`]+\.md)`/gu,
      (_original: string, target: string) =>
        inventory.has(target)
          ? `pstack_reference path "${target}"`
          : "load the named adapted resource through the native skill catalog or pstack_reference"
    )
    .replaceAll(
      /\[(?<capture1>[^\]]+)\]\((?<capture2>[^)]+)\)/gu,
      (original: string, title: string, target: string) => {
        const resource = resolve(target);
        if (resource) {
          return `${title} (pstack_reference path "${resource}")`;
        }
        return /^\.\.?\//u.test(target)
          ? `${title} (upstream guide; consult the native skill catalog for this runtime)`
          : original;
      }
    )
    .replaceAll(
      /`(?<capture1>(?:\.\.\/|\.\/)?(?:references|playbooks)\/[^`]+\.md|\.\.\/[^`]+\/SKILL\.md)`/gu,
      (original: string, target: string) => {
        const resource = resolve(target);
        return resource ? `pstack_reference path "${resource}"` : original;
      }
    );
};

export const loadContent = async (root = vendorRoot) => {
  const groups = await Promise.all([
    markdownFiles(root, "skills"),
    markdownFiles(root, "agents"),
  ]);
  const files = groups.flat();
  const inventory = new Set(files);
  const adapted = new Map<string, string>();
  const skills: PstackSkill[] = [];
  const agents: PstackAgent[] = [];
  const commands: PstackCommand[] = [];
  const commandNames = new Set(
    files
      .filter(
        (path) =>
          path.endsWith("/SKILL.md") ||
          path.startsWith("skills/poteto-mode/playbooks/")
      )
      .map((path) =>
        path.endsWith("/SKILL.md")
          ? nodePath.basename(nodePath.dirname(path))
          : nodePath.basename(path, ".md")
      )
  );
  const sources = await Promise.all(
    files.map((path) => readFile(nodePath.join(root, path), "utf-8"))
  );
  for (const [index, path] of files.entries()) {
    const original = sources[index] ?? "";
    const hasMetadata =
      path.endsWith("/SKILL.md") || path.startsWith("agents/");
    const metadata = hasMetadata ? frontmatter(original, path) : undefined;
    const body = resourceLinks(
      path,
      adaptContent(path, metadata?.body ?? original),
      inventory
    ).replaceAll(
      /(?<![a-zA-Z0-9_/])\/(?<capture1>[a-z][a-z-]*)(?=[`\s.,!?"')\]]|$)/gu,
      (invocation: string, name: string) =>
        commandNames.has(name) ? `/pstack-${name}` : invocation
    );
    const content = `${adapterGuide}\nResource: ${path}\n\n${body}`;
    adapted.set(path, content);
    if (path.endsWith("/SKILL.md")) {
      const name = nodePath.basename(nodePath.dirname(path));
      skills.push({
        content,
        description: metadata?.description ?? name,
        name,
        path: nodePath.join(root, path),
      });
      commands.push({
        description: metadata?.description ?? name,
        name: `pstack-${name}`,
        template: `${content}\n\nUser request: $ARGUMENTS`,
      });
    } else if (path.startsWith("agents/")) {
      agents.push({
        description: metadata?.description ?? path,
        mode: "subagent",
        name: nodePath.basename(path, ".md"),
        system: content,
      });
    } else if (path.startsWith("skills/poteto-mode/playbooks/")) {
      const name = nodePath.basename(path, ".md");
      commands.push({
        description: `Run the pstack ${name.replaceAll("-", " ")} playbook.`,
        name: `pstack-${name}`,
        template: `${content}\n\nUser request: $ARGUMENTS`,
      });
    }
  }
  const main = skills.find((skill) => skill.name === "poteto-mode");
  if (!main) {
    throw new Error("pstack snapshot has no poteto-mode skill");
  }
  agents.unshift({
    description:
      "Run pstack's deliberate implementation, review, and verification workflows.",
    mode: "primary",
    name: "pstack",
    system: main.content,
  });
  commands.unshift({
    agent: "pstack",
    description: "Run pstack with a goal and an acceptance check.",
    name: "pstack",
    template: `${main.content}\n\nUser request: $ARGUMENTS`,
  });
  for (const [name, description, instruction] of [
    [
      "pstack-explorer",
      "Investigate code and source evidence for a scoped pstack task.",
      "Investigate the assigned scope, preserve confidence distinctions, and return source pointers and evidence. Do not edit application code.",
    ],
    [
      "pstack-judgment",
      "Synthesize evidence, write prose, or independently compare pstack candidates.",
      "Evaluate the assigned goal, compare evidence, and state a concrete judgment with its tradeoffs. Write only within the parent's explicit scope.",
    ],
    [
      "pstack-reviewer",
      "Challenge a pstack design or diff with a scoped adversarial review.",
      "Review the assigned code or design against its actual goals. Prove each finding, identify exact symbols and consequences, and separate blockers from preferences. Do not edit application code.",
    ],
    [
      "pstack-verifier",
      "Independently verify pstack work against its acceptance predicate.",
      "Verify the actual artifact at the assigned head SHA. Run the relevant checks and report evidence and limits. Record the verdict with pstack_ledger only when a PR and exact SHA are supplied. A failed, blocked, or type-only check does not prove behavioral readiness.",
    ],
  ] as const) {
    agents.push({
      description,
      mode: "subagent",
      name,
      system: `${adapterGuide}\n${instruction}`,
    });
  }
  return {
    agents,
    commands,
    readReference(path: string): Promise<string> {
      const content = adapted.get(path);
      if (!content) {
        return Promise.reject(
          new Error(
            "Unknown bundled pstack Markdown path. Use an exact inventory path; arbitrary files and scripts are unavailable."
          )
        );
      }
      return Promise.resolve(content);
    },
    references: [...inventory],
    skills,
  };
};
