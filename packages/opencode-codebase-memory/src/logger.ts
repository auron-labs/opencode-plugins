import { appendFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOG_DIR = join(
  process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), '.local', 'share'),
  'opencode',
  'log',
)

let cachedLogFile: string | null = findCurrentLogFile()

function findCurrentLogFile(): string | null {
  try {
    if (!existsSync(LOG_DIR)) return null

    const files = readdirSync(LOG_DIR)
      .filter((file) => file.endsWith('.log'))
      .map((file) => {
        const path = join(LOG_DIR, file)
        const stat = statSync(path)
        return { path, mtime: stat.mtime.getTime(), isFile: stat.isFile() }
      })
      .filter((file) => file.isFile)
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))

    return files[0]?.path ?? null
  } catch {
    return null
  }
}

function getLogFile(): string | null {
  if (cachedLogFile === null || !existsSync(cachedLogFile)) {
    cachedLogFile = findCurrentLogFile()
  }
  return cachedLogFile
}

function write(level: 'INFO' | 'WARN', event: string, message: string, metadata?: Record<string, unknown>): void {
  const logFile = getLogFile()
  if (!logFile) return

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'codebase-memory',
    event,
    message,
    metadata,
  }) + '\n'

  appendFile(logFile, line).catch(() => {})
}

export function info(event: string, message: string, metadata?: Record<string, unknown>): void {
  write('INFO', event, message, metadata)
}

export function warn(event: string, message: string, metadata?: Record<string, unknown>): void {
  write('WARN', event, message, metadata)
}
