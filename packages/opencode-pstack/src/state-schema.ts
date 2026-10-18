import { z } from "zod";

export const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
export const text = z.string().trim().min(1).max(8192);
export const sha = z
  .string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u)
  .toLowerCase();
export const pr = z.number().int().positive().safe();
export const verdict = z.enum([
  "live-ui-verified",
  "unit-test-verified",
  "type-check-only",
  "verifier-blocked",
  "verifier-failed",
]);
const actor = z.object({ agent: text, sessionID: text }).strict();
const timestamp = z.iso.datetime();

const unit = z
  .object({
    branch: text.optional(),
    brief: text.optional(),
    id: identifier,
    pr: pr.optional(),
    sha: sha.optional(),
    state: text,
    track: identifier,
  })
  .strict();
const ledgerEntry = z
  .object({
    actor,
    evidence: text,
    pr,
    sha,
    ts: timestamp,
    verdict,
    verifier: text.optional(),
  })
  .strict();
const inboxEntry = z
  .object({
    agent: text,
    id: z.uuid(),
    report: text.optional(),
    sessionID: text,
    status: text,
    ts: timestamp,
    unit: identifier,
  })
  .strict();
const gateFields = {
  defaultAnswer: text,
  id: identifier,
  options: z.array(text).min(1).max(20),
  question: text,
};
const gate = z.discriminatedUnion("kind", [
  z.object({ ...gateFields, kind: z.literal("open") }).strict(),
  z
    .object({ ...gateFields, answer: text, kind: z.literal("resolved") })
    .strict(),
]);
export const frontierPr = z
  .object({
    branch: text,
    pr,
    sha,
    state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  })
  .strict();
export const decisionFields = {
  decision: text,
  evidence: text,
  phase: text,
  result: text,
  why: text,
};
export const artifactKind = z.enum(["plan", "report", "verification", "note"]);
const artifact = z
  .object({
    actor,
    content: z.string().max(65_536),
    kind: artifactKind,
    name: identifier,
    updatedAt: timestamp,
  })
  .strict();

export const stateSchema = z
  .object({
    artifacts: z.array(artifact),
    decisions: z.array(
      z
        .object({ ...decisionFields, actor, id: z.uuid(), ts: timestamp })
        .strict()
    ),
    frontier: z
      .object({
        generation: z.number().int().nonnegative().safe(),
        lowestUnmerged: pr.nullable(),
        prs: z.array(frontierPr),
      })
      .strict(),
    gates: z.array(gate),
    inbox: z.array(inboxEntry),
    ledger: z.array(ledgerEntry),
    revision: z.number().int().nonnegative().safe(),
    schemaVersion: z.literal(1),
    standing: z.array(text),
    units: z.array(unit),
    updatedAt: timestamp.nullable(),
    updatedBy: actor.nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    const collections = [
      ["units", state.units.map((entry) => entry.id)],
      ["ledger", state.ledger.map((entry) => `${entry.pr}:${entry.sha}`)],
      ["inbox", state.inbox.map((entry) => entry.id)],
      ["gates", state.gates.map((entry) => entry.id)],
      ["decisions", state.decisions.map((entry) => entry.id)],
      ["artifacts", state.artifacts.map((entry) => entry.name)],
      ["frontier", state.frontier.prs.map((entry) => String(entry.pr))],
    ] as const;
    for (const [name, keys] of collections) {
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate ${name} key`,
          path: [name],
        });
      }
    }
    if (
      state.frontier.lowestUnmerged !==
      (state.frontier.prs.find((entry) => entry.state === "OPEN")?.pr ?? null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "frontier lowestUnmerged does not match snapshot",
        path: ["frontier"],
      });
    }
  });

export type State = z.infer<typeof stateSchema>;
export type Actor = z.infer<typeof actor>;

export const emptyState = (): State => ({
  artifacts: [],
  decisions: [],
  frontier: { generation: 0, lowestUnmerged: null, prs: [] },
  gates: [],
  inbox: [],
  ledger: [],
  revision: 0,
  schemaVersion: 1,
  standing: [],
  units: [],
  updatedAt: null,
  updatedBy: null,
});
