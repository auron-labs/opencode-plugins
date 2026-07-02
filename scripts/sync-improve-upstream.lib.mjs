export const REPO = "shadcn/improve";
export const REF = "main";
export const SKILL_PATH = "skills/improve";
export const REFERENCES_SUBDIR = "references";
export const SKILL_FILENAME = "SKILL.md";

export const treeUrl = (repo = REPO, ref = REF) =>
  `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;

export const rawUrl = (
  upstream,
  {
    repo = REPO,
    ref = REF,
    skillPath = SKILL_PATH,
  } = {},
) => `https://raw.githubusercontent.com/${repo}/${ref}/${skillPath}/${upstream}`;

export function filterSkillFiles(
  tree,
  {
    skillPath = SKILL_PATH,
    referencesSubdir = REFERENCES_SUBDIR,
    skillFilename = SKILL_FILENAME,
  } = {},
) {
  if (!tree || tree.truncated === true) {
    throw new Error(
      `Tree response for ${REPO}@${REF} was truncated; cannot reliably discover all files.`,
    );
  }
  const skillEntry = `${skillPath}/${skillFilename}`;
  const refPrefix = `${skillPath}/${referencesSubdir}/`;
  const files = [];
  for (const entry of tree.tree ?? []) {
    if (!entry || entry.type !== "blob") continue;
    if (entry.path === skillEntry) {
      files.push({ local: skillFilename, upstream: skillFilename });
      continue;
    }
    if (entry.path.startsWith(refPrefix) && entry.path.endsWith(".md")) {
      const rel = entry.path.slice(refPrefix.length);
      if (rel.length === 0 || rel.includes("/")) continue;
      files.push({ local: rel, upstream: `${referencesSubdir}/${rel}` });
    }
  }
  files.sort((a, b) => {
    if (a.local === skillFilename) return -1;
    if (b.local === skillFilename) return 1;
    return a.local.localeCompare(b.local);
  });
  return files;
}

export function findStaleLocals(files, localNames) {
  const upstream = new Set(files.map((f) => f.local));
  return [...new Set(localNames)]
    .filter((name) => !upstream.has(name))
    .sort();
}

export function diffLines(prefix, local, upstream) {
  const localLines = local.split("\n");
  const upstreamLines = upstream.split("\n");
  const max = Math.max(localLines.length, upstreamLines.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    const l = localLines[i] ?? "";
    const u = upstreamLines[i] ?? "";
    if (l !== u) {
      out.push(
        `${prefix}  ${String(i + 1).padStart(4, " ")} - ${l}`,
      );
      out.push(
        `${prefix}  ${String(i + 1).padStart(4, " ")} + ${u}`,
      );
    }
  }
  return out.join("\n");
}
