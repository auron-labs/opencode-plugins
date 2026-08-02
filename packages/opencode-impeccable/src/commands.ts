export type ImperfectableCommand = {
  name: string
  category: string
  description: string
  reference: string
  nativeReference?: string
  deprecated?: boolean
  aliases?: string[]
}

export const COMMANDS: ImperfectableCommand[] = [
  { name: "craft", category: "Build", description: "Deprecated alias for an ordinary new-work request", reference: "craft.md", deprecated: true },
  { name: "shape", category: "Build", description: "Plan UX/UI before writing code", reference: "shape.md" },
  { name: "init", category: "Build", description: "Capture durable product context in PRODUCT.md", reference: "init.md", aliases: ["teach"] },
  { name: "document", category: "Build", description: "Generate DESIGN.md from existing project code", reference: "document.md" },
  { name: "extract", category: "Build", description: "Pull reusable tokens and components into design system", reference: "extract.md" },
  { name: "critique", category: "Evaluate", description: "UX design review with heuristic scoring", reference: "critique.md" },
  { name: "audit", category: "Evaluate", description: "Technical quality checks (a11y, perf, responsive)", reference: "audit.md", nativeReference: "audit.native.md" },
  { name: "polish", category: "Refine", description: "Final quality pass before shipping", reference: "polish.md" },
  { name: "bolder", category: "Refine", description: "Amplify safe or bland designs", reference: "bolder.md" },
  { name: "quieter", category: "Refine", description: "Tone down aggressive or overstimulating designs", reference: "quieter.md" },
  { name: "distill", category: "Refine", description: "Strip to essence, remove complexity", reference: "distill.md" },
  { name: "harden", category: "Refine", description: "Production-ready: errors, i18n, edge cases", reference: "harden.md" },
  { name: "onboard", category: "Refine", description: "Design first-run flows, empty states, activation", reference: "onboard.md" },
  { name: "animate", category: "Enhance", description: "Add purposeful animations and motion", reference: "animate.md" },
  { name: "colorize", category: "Enhance", description: "Add strategic color to monochromatic UIs", reference: "colorize.md" },
  { name: "typeset", category: "Enhance", description: "Improve typography hierarchy and fonts", reference: "typeset.md" },
  { name: "layout", category: "Enhance", description: "Fix spacing, rhythm, and visual hierarchy", reference: "layout.md" },
  { name: "delight", category: "Enhance", description: "Add personality and memorable touches", reference: "delight.md" },
  { name: "overdrive", category: "Enhance", description: "Push past conventional limits", reference: "overdrive.md" },
  { name: "clarify", category: "Fix", description: "Improve UX copy, labels, and error messages", reference: "clarify.md" },
  { name: "adapt", category: "Fix", description: "Adapt for different devices and screen sizes", reference: "adapt.md", nativeReference: "adapt.native.md" },
  { name: "optimize", category: "Fix", description: "Diagnose and fix UI performance", reference: "optimize.md" },
  { name: "live", category: "Iterate", description: "Visual variant mode: pick elements in the browser, generate alternatives", reference: "live.md" },
]

export const MENU_REFERENCE = "routing.md"

export function describeCommand(cmd: ImperfectableCommand): string {
  const parts = [
    `/${cmd.name}${cmd.category === "Iterate" ? "" : " [target]"} — ${cmd.description}`,
  ]
  if (cmd.nativeReference) parts.push(`(native: references/${cmd.nativeReference})`)
  if (cmd.deprecated) parts.push("(deprecated)")
  if (cmd.aliases?.length) parts.push(`aliases: ${cmd.aliases.join(", ")}`)
  parts.push(`references/${cmd.reference}`)
  return parts.join(" · ")
}

export function commandList(): string {
  return COMMANDS.map(describeCommand).join("\n")
}
