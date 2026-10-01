import { app } from 'electron'
import { appendFileSync, existsSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

const logPath = join(app.getPath('userData'), 'main-errors.log')
const MAX_LOG_BYTES = 2 * 1024 * 1024

// Best-effort diagnostic trail for errors that would otherwise vanish
// silently in a packaged app with no visible console. Same rotation
// approach as mediaServer.ts's transcode.log.
export function logError(context: string, error: unknown): void {
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      writeFileSync(
        logPath,
        `[${new Date().toISOString()}] (log rotated — exceeded ${MAX_LOG_BYTES} bytes)\n`
      )
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(logPath, `[${new Date().toISOString()}] ${context}: ${message}\n`)
  } catch {
    /* best-effort diagnostics only */
  }
}
