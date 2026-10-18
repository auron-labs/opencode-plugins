import { randomUUID } from "node:crypto";

import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";

import {
  artifactKind,
  decisionFields,
  frontierPr,
  identifier,
  pr,
  sha,
  text,
  verdict,
} from "./state-schema.js";
import type { State } from "./state-schema.js";
import { STATE_RELATIVE_PATH, StateStore, summarize } from "./state.js";

export type AuthorizeStateWrite = (
  context: ToolContext,
  description: string
) => Promise<void>;

const actor = (context: ToolContext) => ({
  agent: context.agent,
  sessionID: context.sessionID,
});

const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new Error(`pstack: ${label} not found`);
  }
  return value;
};

export const buildStateTools = (
  directory: string,
  authorize: AuthorizeStateWrite
): Info[] => {
  const store = new StateStore(directory);
  const tools: Info[] = [];

  const add = <S extends z.ZodType, Result>(
    name: string,
    description: string,
    input: S,
    mutation: boolean,
    run: (args: z.output<S>, state: State, context: ToolContext) => Result
  ): void => {
    const options = mutation
      ? { codemode: false, permission: "pstack_write" }
      : { codemode: false };
    tools.push({
      description,
      async execute(raw, context) {
        const args = input.parse(raw);
        let result: Result;
        if (mutation) {
          await authorize(context, description);
          result = await store.change(
            { agent: context.agent, sessionID: context.sessionID },
            (state) => run(args, state, context),
            context.signal
          );
        } else {
          result = run(args, await store.read(), context);
        }
        return { content: JSON.stringify(result) };
      },
      input,
      name,
      options,
    });
  };

  add(
    "pstack_unit",
    "Add or update a durable project work unit.",
    z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("add"),
          brief: text.optional(),
          id: identifier,
          track: identifier,
        })
        .strict(),
      z
        .object({
          action: z.literal("set"),
          branch: text.optional(),
          id: identifier,
          pr: pr.optional(),
          sha: sha.optional(),
          state: text,
        })
        .strict(),
    ]),
    true,
    (args, state) => {
      if (args.action === "add") {
        if (state.units.some((unit) => unit.id === args.id)) {
          throw new Error(`pstack: unit ${args.id} already exists`);
        }
        const unit = {
          brief: args.brief,
          id: args.id,
          state: "pending",
          track: args.track,
        };
        state.units.push(unit);
        return unit;
      }
      const unit = required(
        state.units.find((entry) => entry.id === args.id),
        `unit ${args.id}`
      );
      const { action: _action, ...fields } = args;
      Object.assign(unit, fields);
      return unit;
    }
  );
  add(
    "pstack_unit_read",
    "Read project work units; optionally filter by state or track.",
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("get"), id: identifier }).strict(),
      z
        .object({
          action: z.literal("list"),
          state: text.optional(),
          track: identifier.optional(),
        })
        .strict(),
    ]),
    false,
    (args, state) =>
      args.action === "get"
        ? required(
            state.units.find((unit) => unit.id === args.id),
            `unit ${args.id}`
          )
        : state.units.filter(
            (unit) =>
              (!args.state || unit.state === args.state) &&
              (!args.track || unit.track === args.track)
          )
  );

  add(
    "pstack_ledger",
    "Record a verification verdict for exactly one PR and full head SHA. A new SHA needs new evidence.",
    z
      .object({
        action: z.literal("record"),
        evidence: text,
        pr,
        sha,
        verdict,
        verifier: text.optional(),
      })
      .strict(),
    true,
    (args, state, context) => {
      const { action: _action, ...fields } = args;
      const entry = {
        ...fields,
        actor: actor(context),
        ts: new Date().toISOString(),
      };
      const index = state.ledger.findIndex(
        (old) => old.pr === args.pr && old.sha === args.sha
      );
      if (index === -1) {
        state.ledger.push(entry);
      } else {
        state.ledger[index] = entry;
      }
      return entry;
    }
  );
  add(
    "pstack_ledger_read",
    "Check the recorded verdict for an exact PR and SHA, or list receipts. This does not query the forge.",
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("check"), pr, sha }).strict(),
      z.object({ action: z.literal("list"), pr: pr.optional() }).strict(),
    ]),
    false,
    (args, state) => {
      if (args.action === "list") {
        return state.ledger.filter(
          (entry) => args.pr === undefined || entry.pr === args.pr
        );
      }
      const entry = state.ledger.find(
        (old) => old.pr === args.pr && old.sha === args.sha
      );
      return {
        entry: entry ?? null,
        pr: args.pr,
        sha: args.sha,
        verdict: entry?.verdict ?? "NOT-VERIFIED",
        verified:
          entry?.verdict === "live-ui-verified" ||
          entry?.verdict === "unit-test-verified",
      };
    }
  );

  add(
    "pstack_inbox",
    "Publish a completion pointer as the current agent, or atomically drain pending pointers.",
    z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("push"),
          report: text.optional(),
          status: text,
          unit: identifier,
        })
        .strict(),
      z.object({ action: z.literal("drain") }).strict(),
    ]),
    true,
    (args, state, context) => {
      if (args.action === "drain") {
        return state.inbox.splice(0);
      }
      const { action: _action, ...fields } = args;
      const entry = {
        ...fields,
        ...actor(context),
        id: randomUUID(),
        ts: new Date().toISOString(),
      };
      state.inbox.push(entry);
      return entry;
    }
  );
  add(
    "pstack_inbox_read",
    "Peek at queued completion pointers without draining them.",
    z.object({ action: z.literal("peek") }).strict(),
    false,
    (_args, state) => state.inbox
  );

  add(
    "pstack_gate",
    "Park a human decision or record its answer. Recording a default does not authorize taking it.",
    z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("park"),
          defaultAnswer: text,
          id: identifier,
          options: z.array(text).min(1).max(20),
          question: text,
        })
        .strict(),
      z
        .object({ action: z.literal("resolve"), answer: text, id: identifier })
        .strict(),
    ]),
    true,
    (args, state) => {
      const index = state.gates.findIndex((gate) => gate.id === args.id);
      if (args.action === "park") {
        const { action: _action, ...fields } = args;
        const gate = { ...fields, kind: "open" as const };
        if (index === -1) {
          state.gates.push(gate);
        } else {
          state.gates[index] = gate;
        }
        return gate;
      }
      const old = required(state.gates[index], `gate ${args.id}`);
      const gate = { ...old, answer: args.answer, kind: "resolved" as const };
      state.gates[index] = gate;
      return gate;
    }
  );
  add(
    "pstack_gate_read",
    "List open human decision gates.",
    z.object({ action: z.literal("list") }).strict(),
    false,
    (_args, state) => state.gates.filter((gate) => gate.kind === "open")
  );

  add(
    "pstack_frontier",
    "Store an observed, ordered PR snapshot. This does not verify the forge or authorize merges, rebases or retargets.",
    z
      .object({
        action: z.literal("set"),
        prs: z.array(frontierPr).max(1000),
      })
      .strict(),
    true,
    (args, state) => {
      if (new Set(args.prs.map((entry) => entry.pr)).size !== args.prs.length) {
        throw new Error("pstack: frontier contains duplicate PRs");
      }
      state.frontier = {
        generation: state.frontier.generation + 1,
        lowestUnmerged:
          args.prs.find((entry) => entry.state === "OPEN")?.pr ?? null,
        prs: args.prs,
      };
      return state.frontier;
    }
  );
  add(
    "pstack_frontier_read",
    "Read the saved frontier observation. Refresh forge facts before acting on it.",
    z.object({ action: z.literal("show") }).strict(),
    false,
    (_args, state) => state.frontier
  );

  add(
    "pstack_standing",
    "Append a durable standing order to carry into delegated briefs.",
    z
      .object({
        action: z.literal("add"),
        line: text,
      })
      .strict(),
    true,
    (args, state) => {
      state.standing.push(args.line);
      return { line: args.line, number: state.standing.length };
    }
  );
  add(
    "pstack_standing_read",
    "Read numbered standing orders for this project.",
    z.object({ action: z.literal("list") }).strict(),
    false,
    (_args, state) =>
      state.standing.map((line, index) => ({ line, number: index + 1 }))
  );

  add(
    "pstack_decision",
    "Append a decision with evidence to the project trail. Earlier decisions cannot be edited or deleted.",
    z
      .object({
        action: z.literal("append"),
        ...decisionFields,
      })
      .strict(),
    true,
    (args, state, context) => {
      const { action: _action, ...fields } = args;
      const entry = {
        ...fields,
        actor: actor(context),
        id: randomUUID(),
        ts: new Date().toISOString(),
      };
      state.decisions.push(entry);
      return entry;
    }
  );
  add(
    "pstack_decision_read",
    "Read the append-only project decision trail.",
    z.object({ action: z.literal("list") }).strict(),
    false,
    (_args, state) => state.decisions
  );

  add(
    "pstack_artifact",
    "Save a named plan, report, verification note or working note in native state. Use this for workflow artifacts rather than shell file writes.",
    z
      .object({
        action: z.literal("write"),
        content: z.string().max(65_536),
        kind: artifactKind,
        name: identifier,
      })
      .strict(),
    true,
    (args, state, context) => {
      if (Buffer.byteLength(args.content) > 65_536) {
        throw new Error("pstack: artifact content exceeds 64 KiB");
      }
      const { action: _action, ...fields } = args;
      const artifact = {
        ...fields,
        actor: actor(context),
        updatedAt: new Date().toISOString(),
      };
      const index = state.artifacts.findIndex(
        (entry) => entry.name === args.name
      );
      if (index === -1) {
        state.artifacts.push(artifact);
      } else {
        state.artifacts[index] = artifact;
      }
      return artifact;
    }
  );
  add(
    "pstack_artifact_read",
    "Read a named native workflow artifact, or list their names and kinds.",
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("read"), name: identifier }).strict(),
      z.object({ action: z.literal("list") }).strict(),
    ]),
    false,
    (args, state) =>
      args.action === "read"
        ? required(
            state.artifacts.find((entry) => entry.name === args.name),
            `artifact ${args.name}`
          )
        : state.artifacts.map(({ name, kind, updatedAt }) => ({
            kind,
            name,
            updatedAt,
          }))
  );

  add(
    "pstack_status",
    "Read durable native project state with derived unit and verification counts. Saved frontier and receipts are observations, not live forge authority.",
    z.object({}).strict(),
    false,
    (_args, state) => ({
      path: STATE_RELATIVE_PATH,
      state,
      summary: summarize(state),
    })
  );
  return tools;
};
