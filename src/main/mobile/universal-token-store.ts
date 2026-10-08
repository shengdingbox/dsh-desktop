import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface UniversalTokenState {
  token?: string
}

export interface UniversalTokenStore {
  load(): UniversalTokenState
  save(state: UniversalTokenState): boolean
}

export function universalTokenStorePath(userDataPath: string): string {
  return join(userDataPath, 'mobile-universal-token.json')
}

export function createFileUniversalTokenStore(path: string): UniversalTokenStore {
  return {
    load: () => readUniversalTokenState(path),
    save: (state) => writeUniversalTokenState(path, state)
  }
}

export function readUniversalTokenState(path: string): UniversalTokenState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }
    if (typeof parsed.token === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(parsed.token)) {
      return { token: parsed.token }
    }
    return {}
  } catch {
    return {}
  }
}

export function writeUniversalTokenState(path: string, state: UniversalTokenState): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (typeof state.token === 'string' && state.token.length > 0) {
      writeFileSync(temporary, `${JSON.stringify({ token: state.token }, undefined, 2)}\n`, { mode: 0o600 })
      if (existsSync(path)) unlinkSync(path)
      renameSync(temporary, path)
    } else {
      // Clearing the token: remove the file.
      if (existsSync(path)) unlinkSync(path)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
    return true
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // The caller already treats a false return as a failed write.
    }
    return false
  }
}
