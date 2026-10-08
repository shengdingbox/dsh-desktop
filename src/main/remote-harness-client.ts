import { randomUUID } from 'node:crypto'
import type { RemoteHarnessConfig } from './remote-harness-manager'

export interface RemoteWorkspace {
  workspaceId: string
  title?: string
  path?: string
  sessionIds?: string[]
  remoteId: string
  remoteName: string
}

export interface RemoteSession {
  sessionId: string
  title?: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  workspaceId?: string
  remoteId: string
}

export class RemoteHarnessClient {
  private cookie?: string

  constructor(private readonly config: RemoteHarnessConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl
  }

  get remoteId(): string {
    return this.config.id
  }

  get remoteName(): string {
    return this.config.name
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.config.baseUrl)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> ?? {})
    }
    
    if (this.cookie) {
      headers.cookie = this.cookie
    }

    const response = await fetch(url, {
      ...init,
      headers
    })

    // Save session cookie if provided
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) {
      const match = setCookie.match(/dsh_mobile=([^;]+)/)
      if (match) {
        this.cookie = `dsh_mobile=${match[1]}`
      }
    }

    return response
  }

  /**
   * Exchange the pairing token for a session cookie.
   * The token is accepted only as `GET /?token=...` on the root path.
   */
  private async exchangeToken(): Promise<boolean> {
    if (!this.config.authToken) return false
    if (this.cookie) return true

    const url = new URL('/', this.config.baseUrl)
    url.searchParams.set('token', this.config.authToken)
    
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
    })

    // The exchange answers 303 to a clean `/`; anything else means the token
    // was stale or already spent.
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) {
      const match = setCookie.match(/dsh_mobile=([^;]+)/)
      if (match) {
        this.cookie = `dsh_mobile=${match[1]}`
        return true
      }
    }
    return false
  }

  /**
   * Ensure we have a valid session cookie, exchanging the token if needed.
   */
  private async ensureAuth(): Promise<boolean> {
    if (this.cookie) return true
    if (!this.config.authToken) return false
    return this.exchangeToken()
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      // First, exchange the pairing token for a session cookie
      if (!(await this.ensureAuth())) {
        return { ok: false, error: 'Token exchange failed. The pairing link may be expired or already used.' }
      }

      const response = await this.fetch('/api/status', { method: 'GET' })
      if (response.ok) {
        return { ok: true }
      }
      if (response.status === 401) {
        return { ok: false, error: 'Authentication failed. Check pairing link.' }
      }
      return { ok: false, error: `HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listWorkspaces(): Promise<{ ok: boolean; workspaces?: RemoteWorkspace[]; error?: string }> {
    try {
      if (!(await this.ensureAuth())) {
        return { ok: false, error: 'Not authenticated' }
      }
      // Try to get workspace list via the mobile bridge endpoint
      const response = await this.fetch('/api/workspace.list', {
        method: 'POST',
        body: JSON.stringify({})
      })

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as { items?: Array<{
        workspaceId?: string
        title?: string
        path?: string
        sessionIds?: string[]
      }> }

      const workspaces: RemoteWorkspace[] = (data.items ?? [])
        .filter(w => typeof w.workspaceId === 'string')
        .map(w => ({
          workspaceId: w.workspaceId!,
          title: w.title,
          path: w.path,
          sessionIds: w.sessionIds,
          remoteId: this.config.id,
          remoteName: this.config.name
        }))

      return { ok: true, workspaces }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listSessions(): Promise<{ ok: boolean; sessions?: RemoteSession[]; error?: string }> {
    try {
      const response = await this.fetch('/api/session.list', {
        method: 'POST',
        body: JSON.stringify({ _request: {} })
      })

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as { items?: Array<{
        sessionId?: string
        title?: string
        updatedAt?: number
        running?: boolean
        blank?: boolean
      }> }

      const sessions: RemoteSession[] = (data.items ?? [])
        .filter(s => typeof s.sessionId === 'string')
        .map(s => ({
          sessionId: s.sessionId!,
          title: s.title,
          updatedAt: s.updatedAt,
          running: s.running,
          blank: s.blank,
          remoteId: this.config.id
        }))

      return { ok: true, sessions }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async createSession(workspaceId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    try {
      const response = await this.fetch('/api/session.create', {
        method: 'POST',
        body: JSON.stringify({ request: { workspaceId } })
      })

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as { sessionId?: string }
      return { ok: true, sessionId: data.sessionId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async getSessionHistory(sessionId: string, maxMessages?: number): Promise<{ ok: boolean; events?: unknown[]; error?: string }> {
    try {
      // First get session list to find cursor
      const listResponse = await this.fetch('/api/session.list', {
        method: 'POST',
        body: JSON.stringify({ _request: {} })
      })

      if (!listResponse.ok) {
        return { ok: false, error: `HTTP ${listResponse.status}` }
      }

      const listData = await listResponse.json() as { items?: Array<{
        sessionId?: string
        projections?: { asOfSeq?: number }
      }> }

      const row = listData.items?.find(item => item.sessionId === sessionId)
      const throughSeq = row?.projections?.asOfSeq

      if (typeof throughSeq !== 'number') {
        return { ok: false, error: 'No cursor for this session' }
      }

      const response = await this.fetch('/api/session.page', {
        method: 'POST',
        body: JSON.stringify({
          request: {
            address: { kind: 'session', sessionId },
            throughSeq,
            ...(typeof maxMessages === 'number' ? { maxMessages } : {})
          }
        })
      })

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as { records?: unknown[] }
      return { ok: true, events: data.records ?? [] }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.fetch('/api/session.prompt', {
        method: 'POST',
        body: JSON.stringify({
          request: {
            requestId: randomUUID(),
            sessionId,
            text
          }
        })
      })

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }

      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async cancelSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.fetch('/api/session.cancel', {
        method: 'POST',
        body: JSON.stringify({ request: { sessionId } })
      })

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }

      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
