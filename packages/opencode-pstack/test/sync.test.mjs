import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";
import test from "node:test";

import {
  syncFromRepository,
  verifyAgainstRepository,
  verifySnapshot,
} from "../scripts/sync-pstack-upstream.mjs";

const fixture = async (t) => {
  const directory = await mkdtemp(
    pathModule.join(tmpdir(), "pstack-sync-test-")
  );
  t.after(() => rm(directory, { force: true, recursive: true }));
  const repository = pathModule.join(directory, "repository");
  const target = pathModule.join(directory, "package");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--quiet");
  const put = async (path, text) => {
    const file = pathModule.join(repository, "pstack", path);
    await mkdir(pathModule.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Sync test",
      "-c",
      "user.email=sync@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture"
    );
    return git("rev-parse", "HEAD").trim();
  };
  await put("LICENSE", "MIT test license\n");
  await put(
    ".cursor-plugin/plugin.json",
    JSON.stringify({
      agents: "./agents/",
      license: "MIT",
      name: "pstack",
      skills: "./skills/",
      version: "1.0.0",
    })
  );
  await put(
    "skills/poteto-mode/SKILL.md",
    "---\nname: Poteto Mode\ndescription: Test workflow\n---\n\nOriginal body.\n"
  );
  await put(
    "agents/poteto-agent.md",
    "---\nname: poteto-agent\ndescription: Delegate\n---\n\nOriginal agent.\n"
  );
  await put("skills/poteto-mode/scripts/unsafe.sh", "exit 99\n");
  commit();
  return { commit, directory, put, repository, target };
};

test("sync pins unchanged source bytes, omits executable runtime, and prunes deleted content", async (t) => {
  const f = await fixture(t);
  await f.put("skills/old/SKILL.md", "Original skill\n");
  const original = f.commit();
  await syncFromRepository(f.repository, original, f.target);
  const lock = await verifySnapshot(f.target);
  assert.equal(lock.commit, original);
  assert.equal(
    await readFile(
      pathModule.join(f.target, "vendor/pstack/skills/old/SKILL.md"),
      "utf-8"
    ),
    "Original skill\n"
  );
  assert.ok(lock.omitted["skills/poteto-mode/scripts/unsafe.sh"]);
  await assert.rejects(
    readFile(
      pathModule.join(
        f.target,
        "vendor/pstack/skills/poteto-mode/scripts/unsafe.sh"
      )
    ),
    { code: "ENOENT" }
  );
  await rm(pathModule.join(f.repository, "pstack/skills/old"), {
    recursive: true,
  });
  await f.put("skills/new/SKILL.md", "Replacement skill\n");
  f.commit();
  await syncFromRepository(f.repository, "HEAD", f.target);
  await verifySnapshot(f.target);
  await assert.rejects(
    readFile(pathModule.join(f.target, "vendor/pstack/skills/old/SKILL.md")),
    { code: "ENOENT" }
  );
});

test("unsupported upstream additions fail without replacing a valid local snapshot", async (t) => {
  const f = await fixture(t);
  await syncFromRepository(f.repository, "HEAD", f.target);
  const previous = await readFile(
    pathModule.join(f.target, "upstream-lock.json"),
    "utf-8"
  );
  await f.put("hooks/new-hook.json", "{}\n");
  f.commit();
  await assert.rejects(
    syncFromRepository(f.repository, "HEAD", f.target),
    /Unclassified/u
  );
  assert.equal(
    await readFile(pathModule.join(f.target, "upstream-lock.json"), "utf-8"),
    previous
  );
  await verifySnapshot(f.target);
});

test("manifest contract drift fails before replacing source", async (t) => {
  const f = await fixture(t);
  await syncFromRepository(f.repository, "HEAD", f.target);
  const previous = await readFile(
    pathModule.join(f.target, "upstream-lock.json"),
    "utf-8"
  );
  await f.put(
    ".cursor-plugin/plugin.json",
    JSON.stringify({ license: "proprietary", name: "pstack", version: "2.0.0" })
  );
  f.commit();
  await assert.rejects(
    syncFromRepository(f.repository, "HEAD", f.target),
    /manifest changed/u
  );
  assert.equal(
    await readFile(pathModule.join(f.target, "upstream-lock.json"), "utf-8"),
    previous
  );
});

test("snapshot verification rejects tampering, extra files, and symlinks", async (t) => {
  const f = await fixture(t);
  await syncFromRepository(f.repository, "HEAD", f.target);
  const path = pathModule.join(f.target, "vendor/pstack/LICENSE");
  await writeFile(path, "changed\n");
  await assert.rejects(
    verifySnapshot(f.target),
    /differs from pinned upstream/u
  );
  await syncFromRepository(f.repository, "HEAD", f.target);
  await writeFile(pathModule.join(f.target, "vendor/pstack/extra.md"), "extra");
  await assert.rejects(verifySnapshot(f.target), /inventory differs/u);
  await syncFromRepository(f.repository, "HEAD", f.target);
  await rm(path);
  await symlink(pathModule.join(f.repository, "pstack/LICENSE"), path);
  await assert.rejects(verifySnapshot(f.target), /non-regular/u);
});

test("checked-in snapshot matches the pinned upstream inventory", async () => {
  await verifySnapshot();
});

test("upstream verification rejects rewritten source even if its local digest was changed", async (t) => {
  const f = await fixture(t);
  await syncFromRepository(f.repository, "HEAD", f.target);
  await verifyAgainstRepository(f.repository, f.target);
  const lock = await verifySnapshot(f.target);
  const replacement = "An edited source document\n";
  await writeFile(
    pathModule.join(f.target, "vendor/pstack/LICENSE"),
    replacement
  );
  lock.files.LICENSE = createHash("sha256").update(replacement).digest("hex");
  await writeFile(
    pathModule.join(f.target, "upstream-lock.json"),
    JSON.stringify(lock)
  );
  await verifySnapshot(f.target);
  await assert.rejects(
    verifyAgainstRepository(f.repository, f.target),
    /immutable upstream source/u
  );
});
