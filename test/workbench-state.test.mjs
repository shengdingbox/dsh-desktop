import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStateStore, emptyState, MAX_STATE_BYTES } from '../packages/dsh-desktop-workbenches/state.mjs'
import { apply } from '../packages/dsh-desktop-workbenches/index.js'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-state-'))
  roots.push(root)
  return { root, store: createStateStore(root) }
}
const populated = () => ({ ...emptyState(), added: ['writer', 'research'], pinned: ['writer', 'research'], active: 'writer',
  favorites: ['writer'], sessionBindings: { 'session-1': 'writer' }, recentSessions: { writer: 'session-1' }, notes: { writer: 'An unsaved business draft' } })

describe('desktop workbench state', () => {
  it('provides detached ownership snapshots from the same persisted state, failing closed on corruption', async () => {
    const { root, store } = await fixture()
    let ownership
    apply({ effect: fn => fn(), inject() {}, reflect: { provide(name, service) {
      expect(name).toBe('desktopWorkbenchOwnership')
      ownership = service
    } }, connection: { fetch: { register() {} } } }, { root })
    await store.write({ revision: 0, state: populated() })
    const snapshot = await ownership.read()
    expect(snapshot).toEqual({ revision: 1, sessionBindings: { 'session-1': 'writer' }, added: ['writer', 'research'] })
    snapshot.added.length = 0
    snapshot.sessionBindings['session-1'] = 'huaxue'
    expect((await ownership.read()).sessionBindings['session-1']).toBe('writer')
    await store.write({ revision: 1, state: { ...populated(), added: ['research'], pinned: ['research'], active: null } })
    expect((await ownership.read()).added).toEqual(['research'])
    await writeFile(join(root, 'state.json'), '{broken')
    await expect(ownership.read()).rejects.toThrow()
  })
  it('starts empty, atomically saves and restores state on host restart', async () => {
    const { root, store } = await fixture()
    expect(await store.read()).toEqual({ revision: 0, state: emptyState() })
    const state = populated()
    const saved = await store.write({ revision: 0, state })
    expect(await createStateStore(root).read()).toEqual(saved)
    expect(await readdir(root)).toEqual(['state.json'])
    state.notes.writer = 'mutated caller'
    saved.state.notes.writer = 'mutated response'
    expect((await store.read()).state.notes.writer).toBe('An unsaved business draft')
  })

  it('migrates legacy v1 state without favorites while preserving its revision and data', async () => {
    const { root, store } = await fixture()
    const { favorites, ...legacyState } = populated()
    await writeFile(join(root, 'state.json'), JSON.stringify({ revision: 7, state: legacyState }))
    expect(await store.read()).toEqual({ revision: 7, state: { ...legacyState, favorites: [] } })
  })

  it('persists adding and removing favorites independently of installed workbenches', async () => {
    const { root, store } = await fixture()
    const initial = { ...populated(), favorites: ['writer', 'catalog-only'] }
    await store.write({ revision: 0, state: initial })
    expect((await createStateStore(root).read()).state.favorites).toEqual(['writer', 'catalog-only'])

    const updated = { ...initial, favorites: ['research'] }
    await store.write({ revision: 1, state: updated })
    expect((await createStateStore(root).read()).state.favorites).toEqual(['research'])
    expect((await store.read()).state.sessionBindings).toEqual(initial.sessionBindings)
    expect((await store.read()).state.notes).toEqual(initial.notes)
  })

  it('accepts Awesome repository identities only in favorites', async () => {
    const { store } = await fixture()
    await expect(store.write({ revision: 0, state: { ...emptyState(), favorites: ['owner/repository'] } })).resolves.toHaveProperty('revision', 1)
    await expect(store.write({ revision: 1, state: { ...emptyState(), added: ['owner/repository'] } })).rejects.toThrow('Invalid added workbench IDs')
  })

  it('rejects a concurrent stale write without losing the winning write', async () => {
    const { store } = await fixture()
    const results = await Promise.allSettled([
      store.write({ revision: 0, state: populated() }),
      store.write({ revision: 0, state: emptyState() })
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].reason.status).toBe(409)
    expect((await store.read()).revision).toBe(1)
    await expect(store.write({ revision: 1, state: populated() })).resolves.toHaveProperty('revision', 2)
  })

  it('removes workbench entries while preserving session ownership, notes and project files', async () => {
    const { root, store } = await fixture()
    await writeFile(join(root, 'project.md'), 'Original user material')
    await store.write({ revision: 0, state: populated() })
    const state = { ...populated(), added: ['research'], pinned: ['research'], active: null }
    await store.write({ revision: 1, state })
    expect((await store.read()).state.sessionBindings['session-1']).toBe('writer')
    expect((await store.read()).state.notes.writer).toBe('An unsaved business draft')
    expect(await readFile(join(root, 'project.md'), 'utf8')).toBe('Original user material')
    await expect(store.write({ revision: 2, state: { ...state, sessionBindings: {} } })).rejects.toHaveProperty('status', 400)
    await expect(store.write({ revision: 2, state: { ...state, notes: {} } })).rejects.toHaveProperty('status', 400)
  })

  it.each([
    { added: ['writer', 'writer'] },
    { favorites: ['writer', 'writer'] },
    { favorites: ['../unsafe'] },
    { favorites: 'writer' },
    { pinned: ['missing'] },
    { active: 'missing' },
    { version: 2 },
    { added: ['../unsafe'] },
    { notes: JSON.parse('{"__proto__":"bad"}') },
    { recentSessions: { writer: 'unbound-session' } },
    { notes: { writer: 42 } }
  ])('rejects malformed state %j without writing it', async (patch) => {
    const { root, store } = await fixture()
    await expect(store.write({ revision: 0, state: { ...populated(), ...patch } })).rejects.toHaveProperty('status', 400)
    expect(await readdir(root)).toEqual([])
  })

  it('does not silently overwrite malformed stored data', async () => {
    const { root, store } = await fixture()
    await writeFile(join(root, 'state.json'), '{broken data')
    await expect(store.read()).rejects.toHaveProperty('status', 500)
    await expect(store.write({ revision: 0, state: emptyState() })).rejects.toHaveProperty('status', 500)
    expect(await readFile(join(root, 'state.json'), 'utf8')).toBe('{broken data')
  })

  it('registers the public host route and enforces request limits including streamed bodies', async () => {
    const { root } = await fixture()
    const routes = []
    apply({ effect: fn => fn(), inject() {}, reflect: { provide() {} }, connection: { fetch: { register(value) { routes.push(value) } } } }, { root })
    const catalogRoute = routes.find(value => value.path === '/api/desktop-workbenches/catalog')
    const readRoute = routes.find(value => value.path === '/api/desktop-workbenches/state')
    const writeRoute = routes.find(value => value.path === '/api/desktop-workbenches/state/write')
    expect(catalogRoute.requestBody).toBe('buffered')
    expect(readRoute.methods).toEqual(['GET'])
    // Without buffered mode, the connection bridge creates a streaming body
    // for GET and Node rejects the Request before it reaches the route.
    expect(readRoute.requestBody).toBe('buffered')
    expect(writeRoute.methods).toEqual(['POST'])
    expect(writeRoute.requestBody).toBe('buffered')
    expect(await (await readRoute.fetch(new Request('http://localhost' + readRoute.path))).json()).toEqual({ revision: 0, state: emptyState() })
    const post = (body) => writeRoute.fetch(new Request('http://localhost' + writeRoute.path, { method: 'POST', body }))
    expect((await post('{invalid')).status).toBe(400)
    const payload = JSON.stringify({ revision: 0, state: populated() })
    expect((await post(payload)).status).toBe(200)
    expect((await post(payload)).status).toBe(409)
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)) },
      cancel() { cancelled = true }
    })
    const response = await writeRoute.fetch(new Request('http://localhost' + writeRoute.path, { method: 'POST', body: stream, duplex: 'half' }))
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect((await post('x'.repeat(MAX_STATE_BYTES + 1))).status).toBe(413)
  })
})
