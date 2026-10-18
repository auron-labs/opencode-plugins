/* oxlint-disable eslint/no-await-in-loop -- Directory traversal and exclusive lock retries require serial I/O. */
/* oxlint-disable eslint/no-bitwise -- Filesystem open flags are an OS bitmask. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import nodePath from "node:path";
import { setTimeout } from "node:timers/promises";

import { z } from "zod";

import { emptyState, stateSchema } from "./state-schema.js";
import type { Actor, State } from "./state-schema.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5000;
export const STATE_RELATIVE_PATH = ".opencode/pstack/state.json";

const ioError = z.object({ code: z.string() });

const checkFile = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(
        `pstack: expected a regular state file with one link at ${path}`
      );
    }
  } catch (error) {
    if (ioError.safeParse(error).data?.code !== "ENOENT") {
      throw error;
    }
  }
};

const loadState = async (path: string): Promise<State> => {
  await checkFile(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (ioError.safeParse(error).data?.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_STATE_BYTES) {
      throw new Error(
        "pstack: state must be a regular file smaller than 16 MiB"
      );
    }
    const raw = await handle.readFile("utf-8");
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) {
      throw new Error("pstack: state exceeds 16 MiB");
    }
    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `pstack: invalid state at ${path}; preserve and repair it before continuing`,
        { cause: error }
      );
    }
  } finally {
    await handle.close();
  }
};

export class StateStore {
  private readonly root: Promise<string>;

  public constructor(directory: string) {
    this.root = realpath(directory);
  }

  private async directory(create: boolean): Promise<string | undefined> {
    let current = await this.root;
    if ((await realpath(current)) !== current) {
      throw new Error("pstack: project root changed");
    }
    for (const name of [".opencode", "pstack"]) {
      current = nodePath.join(current, name);
      if (create) {
        await mkdir(current, { mode: 0o700 }).catch((error) => {
          if (ioError.safeParse(error).data?.code !== "EEXIST") {
            throw error;
          }
        });
      }
      try {
        const info = await lstat(current);
        if (!info.isDirectory()) {
          throw new Error(
            `pstack: state directory must not be a symlink or file: ${current}`
          );
        }
      } catch (error) {
        if (!create && ioError.safeParse(error).data?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }
    return current;
  }

  public async read(): Promise<State> {
    const directory = await this.directory(false);
    if (!directory) {
      return emptyState();
    }
    return loadState(nodePath.join(directory, "state.json"));
  }

  public async change<T>(
    actor: Actor,
    update: (state: State) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const directory = await this.directory(true);
    if (!directory) {
      throw new Error("pstack: state directory is unavailable");
    }
    const lock = nodePath.join(directory, ".lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle;
    while (!handle) {
      signal?.throwIfAborted();
      try {
        handle = await open(
          lock,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600
        );
      } catch (error) {
        if (ioError.safeParse(error).data?.code !== "EEXIST") {
          throw error;
        }
        await checkFile(lock);
        if (Date.now() >= deadline) {
          throw new Error(
            `pstack: state is locked at ${lock}; if its recorded process has exited, remove that stale lock before retrying`,
            { cause: error }
          );
        }
        await setTimeout(25, undefined, { signal });
      }
    }
    try {
      await handle.writeFile(
        JSON.stringify({ actor, pid: process.pid, token: randomUUID() })
      );
      const path = nodePath.join(directory, "state.json");
      const state = await loadState(path);
      const result = update(state);
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      state.updatedBy = actor;
      const contents = `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`;
      if (Buffer.byteLength(contents) > MAX_STATE_BYTES) {
        throw new Error("pstack: state exceeds 16 MiB");
      }
      signal?.throwIfAborted();
      await this.save(directory, path, contents);
      return result;
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }

  private async save(
    directory: string,
    path: string,
    contents: string
  ): Promise<void> {
    const temporary = nodePath.join(directory, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.directory(false);
      await checkFile(path);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (ioError.safeParse(error).data?.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }
}

const count = (values: string[]) => {
  const result: Record<string, number> = Object.create(null);
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
};

export const summarize = (state: State) => ({
  frontierGeneration: state.frontier.generation,
  ledgerVerdicts: count(state.ledger.map((entry) => entry.verdict)),
  openGateIds: state.gates
    .filter((gate) => gate.kind === "open")
    .map((gate) => gate.id),
  pendingInbox: state.inbox.length,
  unitStates: count(state.units.map((unit) => unit.state)),
});

export const loadCheckpoint = async (
  directory: string
): Promise<string | undefined> => {
  const state = await new StateStore(directory).read();
  if (state.revision === 0) {
    return undefined;
  }
  const openGates = state.gates.filter((gate) => gate.kind === "open");
  const recentUnits = state.units.slice(-6);
  return JSON.stringify({
    artifacts: state.artifacts
      .slice(-6)
      .map(({ name, kind }) => ({ kind, name })),
    counts: {
      artifacts: state.artifacts.length,
      decisions: state.decisions.length,
      gates: state.gates.length,
      inbox: state.inbox.length,
      ledger: state.ledger.length,
      openGates: openGates.length,
      standing: state.standing.length,
      units: state.units.length,
    },
    detail:
      "Abbreviated checkpoint. Use pstack_status and pstack_*_read for full state.",
    path: STATE_RELATIVE_PATH,
    revision: state.revision,
    summary: {
      frontierGeneration: state.frontier.generation,
      ledgerVerdicts: count(state.ledger.map((entry) => entry.verdict)),
      openGateIds: openGates.slice(-6).map((gate) => gate.id),
      pendingInbox: state.inbox.length,
    },
    units: recentUnits.map(({ id, state: status }) => ({
      id,
      statePreview: [...status].slice(0, 64).join(""),
      stateTruncated: [...status].length > 64,
    })),
  });
};
