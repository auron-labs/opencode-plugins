import { cp, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

type InstallTarget = {
  source: string
  destination: string
}

const repoRoot = resolve(import.meta.dir)
const opencodeConfigRoot = join(homedir(), ".config", "opencode")

const targets: InstallTarget[] = [
  {
    source: join(repoRoot, "provider", "litellm.ts"),
    destination: join(opencodeConfigRoot, "plugins", "litellm-provider.ts"),
  },
  {
    source: join(repoRoot, "tools", "cocoindex.ts"),
    destination: join(opencodeConfigRoot, "plugins", "cocoindex-tools.ts"),
  },
  {
    source: join(repoRoot, "tui", "gsd-status.tsx"),
    destination: join(opencodeConfigRoot, "tui", "gsd-status.tsx"),
  },
]

const install = async () => {
  console.log(`Installing OpenCode extensions into: ${opencodeConfigRoot}`)

  for (const target of targets) {
    await mkdir(dirname(target.destination), { recursive: true })
    await cp(target.source, target.destination, { force: true })
    console.log(`- Installed ${target.source} -> ${target.destination}`)
  }

  console.log("Done.")
}

install().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(message)
  process.exit(1)
})
