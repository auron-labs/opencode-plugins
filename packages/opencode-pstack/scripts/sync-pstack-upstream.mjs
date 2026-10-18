import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { z } from "zod";

const exec = promisify(execFile);
const packageRoot = pathModule.resolve(import.meta.dirname, "..");
const repositoryURL = "https://github.com/cursor/plugins.git";
const hash = (body) => createHash("sha256").update(body).digest("hex");
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const lockSchema = z.strictObject({
  commit: commitSchema,
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
  omitted: z.record(z.string(), commitSchema),
  repository: z.literal(repositoryURL),
  schemaVersion: z.literal(1),
  version: z.string().min(1),
});
const manifestSchema = z.object({
  agents: z.literal("./agents/"),
  license: z.literal("MIT"),
  name: z.literal("pstack"),
  skills: z.literal("./skills/"),
  version: z.string().min(1),
});

const git = async (repository, ...args) => {
  const { stdout } = await exec("git", ["-C", repository, ...args], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
};

const classify = (path) => {
  if (
    !/^[a-zA-Z0-9_./-]+$/u.test(path) ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Unsafe upstream path: ${path}`);
  }
  if (
    [
      "LICENSE",
      "README.md",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ].includes(path)
  ) {
    return "content";
  }
  if (
    /^(?:agents|skills)\//u.test(path) &&
    path.endsWith(".md") &&
    !path.includes("/scripts/")
  ) {
    return "content";
  }
  if (
    path === ".gitignore" ||
    path === "skills/show-me-your-work/references/decision-log-template.tsv" ||
    /^(?:assets|docs|automations)\//u.test(path) ||
    /^skills\/[^/]+\/scripts\//u.test(path)
  ) {
    return "omitted";
  }
  throw new Error(
    `Unclassified upstream file: ${path}. Review its OpenCode integration before updating.`
  );
};

const inventory = async (repository, commit) => {
  const listing = await git(
    repository,
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    "pstack/"
  );
  const files = [];
  const omitted = {};
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match =
      /^(?<mode>\d+) blob (?<sha>[a-f0-9]{40})\t(?<file>pstack\/.+)$/u.exec(
        entry
      );
    if (!match || !["100644", "100755"].includes(match.groups.mode)) {
      throw new Error(`Unsupported upstream entry: ${entry}`);
    }
    const path = match.groups.file.slice("pstack/".length);
    if (classify(path) === "content") {
      files.push(path);
    } else {
      omitted[path] = match.groups.sha;
    }
  }
  for (const required of [
    "LICENSE",
    ".cursor-plugin/plugin.json",
    "skills/poteto-mode/SKILL.md",
    "agents/poteto-agent.md",
  ]) {
    if (!files.includes(required)) {
      throw new Error(`Incomplete upstream snapshot: missing ${required}`);
    }
  }
  return { files: files.toSorted(), omitted };
};

const listFiles = async (directory, prefix = "") => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        return listFiles(pathModule.join(directory, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        return [path];
      }
      throw new Error(`Snapshot contains a non-regular file: ${path}`);
    })
  );
  return paths.flat().toSorted();
};

export const verifySnapshot = async (root = packageRoot) => {
  const lock = lockSchema.parse(
    JSON.parse(
      await readFile(pathModule.join(root, "upstream-lock.json"), "utf-8")
    )
  );
  const snapshot = pathModule.join(root, "vendor", "pstack");
  const actual = await listFiles(snapshot);
  const expected = Object.keys(lock.files).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Snapshot inventory differs from upstream-lock.json");
  }
  await Promise.all(
    actual.map(async (path) => {
      if (
        classify(path) !== "content" ||
        hash(await readFile(pathModule.join(snapshot, path))) !==
          lock.files[path]
      ) {
        throw new Error(
          `Snapshot content differs from pinned upstream: ${path}`
        );
      }
    })
  );
  return lock;
};

const replaceSnapshot = async (root, stage) => {
  const destination = pathModule.join(root, "vendor", "pstack");
  const backup = pathModule.join(stage, "previous");
  await mkdir(pathModule.dirname(destination), { recursive: true });
  let previous = false;
  try {
    await rename(destination, backup);
    previous = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await rename(pathModule.join(stage, "vendor", "pstack"), destination);
    await rename(
      pathModule.join(stage, "upstream-lock.json"),
      pathModule.join(root, "upstream-lock.json")
    );
  } catch (error) {
    await rm(destination, { force: true, recursive: true });
    if (previous) {
      await rename(backup, destination);
    }
    throw error;
  }
};

export const syncFromRepository = async (
  repository,
  ref = "HEAD",
  root = packageRoot
) => {
  const resolved = await git(
    repository,
    "rev-parse",
    "--verify",
    `${ref}^{commit}`
  );
  const commit = commitSchema.parse(resolved.trim());
  const { files, omitted } = await inventory(repository, commit);
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(pathModule.join(root, ".pstack-sync-"));
  const candidate = pathModule.join(stage, "vendor", "pstack");
  try {
    const results = await Promise.allSettled(
      files.map(async (path) => {
        const content = await git(
          repository,
          "show",
          `${commit}:pstack/${path}`
        );
        await mkdir(pathModule.dirname(pathModule.join(candidate, path)), {
          recursive: true,
        });
        await writeFile(pathModule.join(candidate, path), content);
        return [path, hash(content)];
      })
    );
    const digests = Object.fromEntries(
      results.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }
        return result.value;
      })
    );
    const parsed = manifestSchema.safeParse(
      JSON.parse(
        await readFile(
          pathModule.join(candidate, ".cursor-plugin/plugin.json"),
          "utf-8"
        )
      )
    );
    if (!parsed.success) {
      throw new Error(
        "Upstream plugin manifest changed; review its licensing and registration contract"
      );
    }
    const lock = {
      commit,
      files: digests,
      omitted,
      repository: repositoryURL,
      schemaVersion: 1,
      version: parsed.data.version,
    };
    await writeFile(
      pathModule.join(stage, "upstream-lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    );
    await verifySnapshot(stage);
    await replaceSnapshot(root, stage);
    return lock;
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
};

export const verifyAgainstRepository = async (
  repository,
  root = packageRoot
) => {
  const actual = await verifySnapshot(root);
  const comparison = await mkdtemp(
    pathModule.join(tmpdir(), "pstack-compare-")
  );
  try {
    const expected = await syncFromRepository(
      repository,
      actual.commit,
      comparison
    );
    assert.deepEqual(
      actual,
      expected,
      "Snapshot and lock must match immutable upstream source"
    );
  } finally {
    await rm(comparison, { force: true, recursive: true });
  }
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      remote: { type: "boolean" },
      source: { type: "string" },
    },
  });
  if (
    positionals.length > 1 ||
    (positionals[0] && positionals[0] !== "check")
  ) {
    throw new Error(
      "Usage: sync-pstack-upstream.mjs [check [--remote]] [--source <git-repository>] [--ref <commit>]"
    );
  }
  if (positionals[0] === "check") {
    const lock = await verifySnapshot();
    if (values.remote) {
      const directory = await mkdtemp(
        pathModule.join(tmpdir(), "pstack-verify-")
      );
      try {
        await git(directory, "init", "--quiet");
        await git(directory, "fetch", "--depth=1", repositoryURL, lock.commit);
        await verifyAgainstRepository(directory, packageRoot);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
    console.log(`Verified pstack ${lock.version} at ${lock.commit}`);
    return;
  }
  if (values.ref && !commitSchema.safeParse(values.ref).success) {
    throw new Error("--ref requires a full Git commit SHA");
  }
  await mkdir(packageRoot, { recursive: true });
  const lockDirectory = pathModule.join(packageRoot, ".pstack-sync.lock");
  await mkdir(lockDirectory);
  let checkout;
  try {
    if (!values.source) {
      checkout = await mkdtemp(
        pathModule.join(tmpdir(), "opencode-pstack-upstream-")
      );
      await git(checkout, "init", "--quiet");
      await git(
        checkout,
        "fetch",
        "--depth=1",
        repositoryURL,
        values.ref ?? "main"
      );
    }
    const result = await syncFromRepository(
      values.source ?? checkout,
      values.ref ?? (values.source ? "HEAD" : "FETCH_HEAD")
    );
    console.log(
      `Synced pstack ${result.version} at ${result.commit}. Run the package tests before accepting this update.`
    );
  } finally {
    if (checkout) {
      await rm(checkout, { force: true, recursive: true });
    }
    await rm(lockDirectory, { force: true, recursive: true });
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(pathModule.resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
