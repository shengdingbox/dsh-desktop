import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export interface RemoteWorkspace {
  workspaceId: string
  title?: string
  path?: string
  sessionIds?: string[]
}

export interface RemoteHarnessConfig {
  id: string
  name: string
  baseUrl: string
  authToken?: string
  /** Saved session cookie from token exchange */
  sessionCookie?: string
  /** Cached remote workspaces */
  workspaces?: RemoteWorkspace[]
  addedAt: number
  lastConnectedAt?: number
}

export interface RemoteHarnessState {
  remotes: RemoteHarnessConfig[]
}

export class RemoteHarnessManager {
  private state: RemoteHarnessState = { remotes: [] }
  private readonly filePath: string
  private loaded = false

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'remote-harness.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RemoteHarnessState>
      if (parsed && Array.isArray(parsed.remotes)) {
        this.state.remotes = parsed.remotes.filter((r): r is RemoteHarnessConfig =>
          typeof r.id === 'string' &&
          typeof r.name === 'string' &&
          typeof r.baseUrl === 'string' &&
          typeof r.addedAt === 'number'
        )
      }
    } catch {
      // File doesn't exist or is invalid - start with empty state
    }
    this.loaded = true
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
  }

  list(): RemoteHarnessConfig[] {
    return [...this.state.remotes]
  }

  get(id: string): RemoteHarnessConfig | undefined {
    return this.state.remotes.find(r => r.id === id)
  }

  async add(config: Omit<RemoteHarnessConfig, 'id' | 'addedAt'>): Promise<RemoteHarnessConfig> {
    const remote: RemoteHarnessConfig = {
      ...config,
      id: randomUUID(),
      addedAt: Date.now()
    }
    this.state.remotes.push(remote)
    await this.save()
    return remote
  }

  async remove(id: string): Promise<boolean> {
    const index = this.state.remotes.findIndex(r => r.id === id)
    if (index === -1) return false
    this.state.remotes.splice(index, 1)
    await this.save()
    return true
  }

  async update(id: string, updates: Partial<Omit<RemoteHarnessConfig, 'id' | 'addedAt'>>): Promise<RemoteHarnessConfig | undefined> {
    const remote = this.get(id)
    if (!remote) return undefined
    Object.assign(remote, updates)
    await this.save()
    return remote
  }

  async markConnected(id: string): Promise<void> {
    const remote = this.get(id)
    if (remote) {
      remote.lastConnectedAt = Date.now()
      await this.save()
    }
  }

  /**
   * Parse a pairing URL to extract connection info.
   * Supports formats:
   * - http://host:port/pair?token=xxx
   * - https://tunnel-url.trycloudflare.com/pair?token=xxx
   */
  static parsePairingUrl(url: string): { baseUrl: string; authToken?: string } | null {
    try {
      const parsed = new URL(url)
      const token = parsed.searchParams.get('token')
      // Remove /pair path to get base URL
      parsed.pathname = ''
      parsed.search = ''
      const baseUrl = parsed.toString().replace(/\/$/, '')
      
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        return null
      }

      return {
        baseUrl,
        authToken: token ?? undefined
      }
    } catch {
      return null
    }
  }
}
