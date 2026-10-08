/**
 * Remote Harness 桌面端 UI。
 *
 * 在侧边栏注入一个入口按钮，点击弹出管理弹层，可添加/删除/测试远程 Harness。
 * 远程工作区的会话在新窗口打开（远程 Harness Web UI 自身的会话列表），
 * 因为远程 Harness 的会话无法嵌入本地 UI（CORS + 独立认证）。
 *
 * 注意：此模块在 sandbox preload 中运行，不能访问 window.dshRemoteHarness。
 * 直接使用 ipcRenderer.invoke 调用 main 进程。
 */

import { ipcRenderer } from 'electron'

export interface RemoteHarnessEntry {
  id: string
  name: string
  baseUrl: string
  addedAt: number
  lastConnectedAt?: number
}

const BUTTON_ID = 'dsh-desktop-remote-button'
const PANEL_ID = 'dsh-desktop-remote-panel'
const STYLE_ID = 'dsh-desktop-remote-styles'

const remoteIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 12h17M12 3.5c-4.7 4.9-4.7 12.1 0 17M12 3.5c4.7 4.9 4.7 12.1 0 17" stroke="currentColor" stroke-width="1.4"/></svg>`

const styles = `
  #${BUTTON_ID} { appearance:none; width:32px; height:32px; color:var(--dsw-alias-label-secondary,#73777f); background:transparent; border:0; border-radius:9px; display:inline-flex !important; align-items:center; justify-content:center; cursor:pointer; flex:none; visibility:visible !important; opacity:1 !important; }
  [data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] [data-dsh-sidebar-settings] { flex-direction:column; align-items:center; }
  [data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] #${BUTTON_ID} { margin-top:5px; }
  [data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] [data-dsh-sidebar-settings] { position:relative; padding-right:38px; }
  [data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] #${BUTTON_ID} { position:absolute; right:0; top:calc(50% + 20px); }
  #${BUTTON_ID}:hover { color:var(--dsw-alias-label-primary,#202124); background:var(--dsw-alias-interactive-bg-hover,rgba(32,33,36,.08)); }
  #${BUTTON_ID}:focus-visible { outline:2px solid #4d6bfe; outline-offset:1px; }
  #${BUTTON_ID}.is-open { color:var(--dsw-alias-label-primary,#202124); background:var(--dsw-alias-interactive-bg-hover,rgba(32,33,36,.08)); }

  #${PANEL_ID} {
    position: fixed;
    right: 16px;
    bottom: 72px;
    width: 360px;
    max-height: min(70vh, 520px);
    background: var(--dsw-specific-sidebar-fill, #fff);
    border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
    border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.18);
    z-index: 2147483646;
    display: none;
    flex-direction: column;
    overflow: hidden;
    color: var(--dsw-alias-label-primary, #202124);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #${PANEL_ID}.open { display: flex; }
  #${PANEL_ID} .remote-header { padding: 14px 16px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
  #${PANEL_ID} .remote-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
  #${PANEL_ID} .remote-header p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary, #73777f); font-size: 12px; }
  #${PANEL_ID} .remote-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
  #${PANEL_ID} .remote-form { display: grid; gap: 8px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
  #${PANEL_ID} .remote-form label { font-size: 12px; color: var(--dsw-alias-label-secondary, #73777f); }
  #${PANEL_ID} .remote-form input {
    height: 34px; padding: 0 10px;
    border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
    border-radius: 8px; background: transparent; color: inherit;
    font: inherit; outline: none;
  }
  #${PANEL_ID} .remote-form input:focus { border-color: #4d6bfe; }
  #${PANEL_ID} .remote-form .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  #${PANEL_ID} button.primary {
    height: 32px; padding: 0 14px; border: 0; border-radius: 8px;
    background: #4d6bfe; color: #fff; font: inherit; font-weight: 500;
    cursor: pointer;
  }
  #${PANEL_ID} button.primary:disabled { opacity: .5; cursor: default; }
  #${PANEL_ID} button.ghost {
    height: 32px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
    border-radius: 8px; background: transparent; color: inherit;
    font: inherit; cursor: pointer;
  }
  #${PANEL_ID} .remote-list { display: grid; gap: 8px; }
  #${PANEL_ID} .remote-item {
    display: grid; gap: 4px; padding: 10px 12px;
    border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
    border-radius: 10px;
  }
  #${PANEL_ID} .remote-item .name { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; }
  #${PANEL_ID} .remote-item .url { color: var(--dsw-alias-label-secondary, #73777f); font-size: 11px; word-break: break-all; }
  #${PANEL_ID} .remote-item .status { font-size: 11px; }
  #${PANEL_ID} .remote-item .status.ok { color: #35a867; }
  #${PANEL_ID} .remote-item .status.err { color: #e34d59; }
  #${PANEL_ID} .remote-item .item-actions { display: flex; gap: 6px; margin-top: 4px; }
  #${PANEL_ID} .remote-item .item-actions button {
    height: 26px; padding: 0 10px; font-size: 12px;
    border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
    border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
  }
  #${PANEL_ID} .remote-item .item-actions button.danger { color: #e34d59; border-color: rgba(227,77,89,.4); }
  #${PANEL_ID} .remote-item .item-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
  #${PANEL_ID} .empty { color: var(--dsw-alias-label-secondary, #73777f); font-size: 12px; text-align: center; padding: 20px 0; }
  #${PANEL_ID} .form-error { color: #e34d59; font-size: 12px; min-height: 16px; }
  #${PANEL_ID} .local-harness {
    display: grid; gap: 6px; padding: 10px 12px; margin-bottom: 12px;
    border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
    border-radius: 10px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.02));
  }
  #${PANEL_ID} .local-harness-label { font-size: 12px; font-weight: 600; }
  #${PANEL_ID} .local-harness-row { display: flex; gap: 6px; align-items: center; }
  #${PANEL_ID} .local-harness-url {
    flex: 1; min-width: 0; font-size: 11px; word-break: break-all;
    color: var(--dsw-alias-label-secondary, #73777f);
    background: var(--dsw-alias-surface-l2, rgba(0,0,0,.04));
    padding: 5px 8px; border-radius: 6px; user-select: all;
  }
  #${PANEL_ID} .local-harness-copy {
    flex: none; height: 24px; padding: 0 10px; font-size: 11px;
    border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
    border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
  }
  #${PANEL_ID} .local-harness-copy:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
  #${PANEL_ID} .local-harness-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #73777f); }
  #${PANEL_ID} [hidden] { display: none !important; }
`

// 直接使用 ipcRenderer 调用 main 进程
const api = {
  list: (): Promise<RemoteHarnessEntry[]> => ipcRenderer.invoke('remote:list'),
  add: (config: { name: string; pairingUrl: string }): Promise<{ ok: boolean; remote?: RemoteHarnessEntry; error?: string }> =>
    ipcRenderer.invoke('remote:add', config),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('remote:remove', id),
  test: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('remote:test', id),
  workspaces: (id: string): Promise<{ ok: boolean; workspaces?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('remote:workspaces', id),
  sessions: (id: string): Promise<{ ok: boolean; sessions?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('remote:sessions', id),
  localHarnessUrl: (): Promise<string | null> => ipcRenderer.invoke('remote:local-harness-url')
}

export function mountRemoteHarnessButton(): void {
  injectStyles()
  mountButton()
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = styles
  document.head.appendChild(style)
}

let buttonEl: HTMLButtonElement | undefined
let panelEl: HTMLElement | undefined
let listEl: HTMLElement | undefined
let formErrorEl: HTMLElement | undefined
let nameInput: HTMLInputElement | undefined
let urlInput: HTMLInputElement | undefined
let addButton: HTMLButtonElement | undefined
let isOpen = false
let entries: RemoteHarnessEntry[] = []
let refreshInFlight = false

function mountButton(): void {
  const settingsArea = document.querySelector('[data-dsh-sidebar-settings]')
  if (!settingsArea) {
    return
  }

  if (!buttonEl?.isConnected) {
    buttonEl = (document.getElementById(BUTTON_ID) as HTMLButtonElement | null) ?? undefined
  }
  if (!buttonEl) {
    const created = document.createElement('button')
    created.id = BUTTON_ID
    created.type = 'button'
    created.innerHTML = remoteIcon
    created.title = locale() === 'zh' ? '远程 Harness' : 'Remote Harness'
    created.setAttribute('aria-label', created.title)
    created.addEventListener('click', togglePanel)
    // 强制可见
    created.style.display = 'inline-flex'
    created.style.visibility = 'visible'
    created.style.opacity = '1'
    buttonEl = created
  }
  if (buttonEl.parentElement !== settingsArea) {
    settingsArea.appendChild(buttonEl)
  }
  // 确保按钮始终可见
  buttonEl.style.display = 'inline-flex'
  buttonEl.style.visibility = 'visible'
  buttonEl.style.opacity = '1'
}

function togglePanel(): void {
  if (isOpen) {
    closePanel()
  } else {
    openPanel()
  }
}

async function openPanel(): Promise<void> {
  if (!buttonEl) return
  mountPanel()
  isOpen = true
  panelEl?.classList.add('open')
  buttonEl.classList.add('is-open')
  await refreshList()
  nameInput?.focus()
}

function closePanel(): void {
  isOpen = false
  panelEl?.classList.remove('open')
  buttonEl?.classList.remove('is-open')
}

function mountPanel(): void {
  if (panelEl?.isConnected) return

  panelEl = document.createElement('section')
  panelEl.id = PANEL_ID
  panelEl.setAttribute('role', 'dialog')
  panelEl.setAttribute('aria-modal', 'false')
  panelEl.innerHTML = `
    <div class="remote-header">
      <h2 data-i18n="title"></h2>
      <p data-i18n="subtitle"></p>
    </div>
    <div class="remote-body">
      <div class="local-harness" id="local-harness">
        <div class="local-harness-label" data-i18n="localLabel"></div>
        <div class="local-harness-row">
          <code class="local-harness-url" id="local-harness-url"></code>
          <button type="button" class="local-harness-copy" id="local-harness-copy"></button>
        </div>
        <div class="local-harness-hint" data-i18n="localHint"></div>
      </div>
      <form class="remote-form" id="remote-form">
        <label data-i18n="nameLabel" for="remote-name"></label>
        <input id="remote-name" type="text" autocomplete="off" />
        <label data-i18n="urlLabel" for="remote-url"></label>
        <input id="remote-url" type="text" autocomplete="off" spellcheck="false" />
        <div class="form-error" id="remote-form-error" aria-live="polite"></div>
        <div class="actions">
          <button type="submit" class="primary" id="remote-add"></button>
        </div>
      </form>
      <div class="remote-list" id="remote-list"></div>
      <div class="remote-workspaces" id="remote-workspaces" hidden>
        <h3 data-i18n="workspacesTitle"></h3>
        <div class="workspace-list" id="workspace-list"></div>
      </div>
    </div>
  `
  document.body.appendChild(panelEl)

  // i18n
  const zh = locale() === 'zh'
  setText(panelEl, 'title', zh ? '远程 Harness' : 'Remote Harness')
  setText(panelEl, 'subtitle', zh
    ? '通过配对链接连接其他设备的 Harness，在下方查看并打开其工作区。'
    : 'Connect another device\'s Harness via a pairing link and view its workspaces below.')
  setText(panelEl, 'nameLabel', zh ? '名称' : 'Name')
  setText(panelEl, 'urlLabel', zh ? '配对链接（http://... 或 https://.../pair?token=...）' : 'Pairing link (http://... or https://.../pair?token=...)')
  setText(panelEl.querySelector('#remote-add') as HTMLElement, null, zh ? '添加' : 'Add')
  setText(panelEl, 'workspacesTitle', zh ? '远程工作区' : 'Remote Workspaces')
  setText(panelEl, 'localLabel', zh ? '本机 Harness 地址' : 'Local Harness URL')
  setText(panelEl, 'localHint', zh
    ? '其他设备可用此地址作为配对链接添加本机。'
    : 'Other devices can add this machine using this URL as the pairing link.')

  // Fill the local harness URL
  const localUrlEl = panelEl.querySelector('#local-harness-url') as HTMLElement
  const localCopyBtn = panelEl.querySelector('#local-harness-copy') as HTMLButtonElement
  localCopyBtn.textContent = zh ? '复制' : 'Copy'
  void api.localHarnessUrl().then((url) => {
    if (url) {
      localUrlEl.textContent = url
    } else {
      localUrlEl.textContent = zh ? '（Harness 未就绪）' : '(Harness not ready)'
    }
  }).catch(() => {
    localUrlEl.textContent = zh ? '（获取失败）' : '(failed to load)'
  })
  localCopyBtn.addEventListener('click', () => {
    const text = localUrlEl.textContent ?? ''
    if (!text || text.startsWith('（') || text.startsWith('(')) return
    void navigator.clipboard.writeText(text).then(() => {
      localCopyBtn.textContent = zh ? '已复制' : 'Copied'
      setTimeout(() => { localCopyBtn.textContent = zh ? '复制' : 'Copy' }, 1500)
    }).catch(() => {
      // Clipboard may be unavailable; select the text as a fallback.
      const range = document.createRange()
      range.selectNodeContents(localUrlEl)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  })

  listEl = panelEl.querySelector('#remote-list') as HTMLElement
  formErrorEl = panelEl.querySelector('#remote-form-error') as HTMLElement
  nameInput = panelEl.querySelector('#remote-name') as HTMLInputElement
  urlInput = panelEl.querySelector('#remote-url') as HTMLInputElement
  addButton = panelEl.querySelector('#remote-add') as HTMLButtonElement

  nameInput.placeholder = zh ? '例如：家里的台式机' : 'e.g. Home Desktop'
  urlInput.placeholder = 'https://xxx.trycloudflare.com/pair?token=...'

  panelEl.querySelector('#remote-form')?.addEventListener('submit', onAddSubmit)

  document.addEventListener('click', onOutsideClick, true)
  document.addEventListener('keydown', onEscape)
}

function setText(root: ParentNode, key: string | null, value: string): void {
  if (key === null) {
    (root as HTMLElement).textContent = value
  } else {
    const el = root.querySelector(`[data-i18n="${key}"]`)
    if (el) el.textContent = value
  }
}

function locale(): 'en' | 'zh' {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function onOutsideClick(event: MouseEvent): void {
  if (!isOpen || !panelEl || !buttonEl) return
  const target = event.target as Node
  if (panelEl.contains(target) || buttonEl.contains(target)) return
  closePanel()
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isOpen) closePanel()
}

async function onAddSubmit(event: Event): Promise<void> {
  event.preventDefault()
  if (!nameInput || !urlInput || !addButton || !formErrorEl) return

  const name = nameInput.value.trim()
  const pairingUrl = urlInput.value.trim()
  formErrorEl.textContent = ''

  if (!name) {
    formErrorEl.textContent = locale() === 'zh' ? '请输入名称' : 'Name is required'
    return
  }
  if (!pairingUrl) {
    formErrorEl.textContent = locale() === 'zh' ? '请输入配对链接' : 'Pairing link is required'
    return
  }

  addButton.disabled = true
  addButton.textContent = locale() === 'zh' ? '添加中…' : 'Adding…'

  try {
    const result = await api.add({ name, pairingUrl })
    if (result.ok) {
      nameInput.value = ''
      urlInput.value = ''
      await refreshList()
    } else {
      formErrorEl.textContent = result.error ?? (locale() === 'zh' ? '添加失败' : 'Failed to add')
    }
  } catch (error) {
    formErrorEl.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    addButton.disabled = false
    addButton.textContent = locale() === 'zh' ? '添加' : 'Add'
  }
}

async function refreshList(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    entries = await api.list()
    renderList()
  } catch (error) {
    console.error('[remote-harness] failed to list:', error)
  } finally {
    refreshInFlight = false
  }
}

function renderList(): void {
  if (!listEl) return
  const zh = locale() === 'zh'

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="empty">${zh ? '尚未添加远程 Harness' : 'No remote Harness added yet'}</div>`
    return
  }

  listEl.innerHTML = ''
  for (const entry of entries) {
    const item = document.createElement('div')
    item.className = 'remote-item'

    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = entry.name
    item.appendChild(name)

    const url = document.createElement('div')
    url.className = 'url'
    url.textContent = entry.baseUrl
    item.appendChild(url)

    const status = document.createElement('div')
    status.className = 'status'
    status.setAttribute('aria-live', 'polite')
    status.textContent = entry.lastConnectedAt
      ? `${zh ? '上次连接' : 'Last connected'}: ${new Date(entry.lastConnectedAt).toLocaleString()}`
      : (zh ? '未连接过' : 'Never connected')
    item.appendChild(status)

    const actions = document.createElement('div')
    actions.className = 'item-actions'

    const testBtn = document.createElement('button')
    testBtn.type = 'button'
    testBtn.textContent = zh ? '测试' : 'Test'
    testBtn.addEventListener('click', () => onTest(entry.id, status, testBtn))
    actions.appendChild(testBtn)

    const workspacesBtn = document.createElement('button')
    workspacesBtn.type = 'button'
    workspacesBtn.textContent = zh ? '工作区' : 'Workspaces'
    workspacesBtn.addEventListener('click', () => onLoadWorkspaces(entry.id, item))
    actions.appendChild(workspacesBtn)

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'danger'
    removeBtn.textContent = zh ? '删除' : 'Remove'
    removeBtn.addEventListener('click', () => onRemove(entry.id, item, removeBtn))
    actions.appendChild(removeBtn)

    item.appendChild(actions)
    listEl.appendChild(item)
  }
}

async function onTest(id: string, statusEl: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const zh = locale() === 'zh'
  btn.disabled = true
  statusEl.className = 'status'
  statusEl.textContent = zh ? '测试中…' : 'Testing…'
  try {
    const result = await api.test(id)
    if (result.ok) {
      statusEl.className = 'status ok'
      statusEl.textContent = zh ? '连接成功' : 'Connected'
      await refreshList()
    } else {
      statusEl.className = 'status err'
      statusEl.textContent = result.error ?? (zh ? '连接失败' : 'Failed')
    }
  } catch (error) {
    statusEl.className = 'status err'
    statusEl.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    btn.disabled = false
  }
}

async function onLoadWorkspaces(id: string, item: HTMLElement): Promise<void> {
  const zh = locale() === 'zh'
  
  // 查找或创建工作区容器
  let wsContainer = item.querySelector('.remote-workspaces') as HTMLElement
  if (!wsContainer) {
    wsContainer = document.createElement('div')
    wsContainer.className = 'remote-workspaces'
    wsContainer.style.marginTop = '8px'
    wsContainer.style.paddingTop = '8px'
    wsContainer.style.borderTop = '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))'
    item.appendChild(wsContainer)
  }

  // 如果已经加载，切换显示/隐藏
  if (wsContainer.dataset.loaded === 'true') {
    wsContainer.hidden = !wsContainer.hidden
    return
  }

  wsContainer.innerHTML = `<div style="color: var(--dsw-alias-label-secondary, #73777f); font-size: 12px;">${zh ? '加载中…' : 'Loading…'}</div>`

  try {
    const result = await api.workspaces(id)
    if (!result.ok || !result.workspaces) {
      wsContainer.innerHTML = `<div style="color: #e34d59; font-size: 12px;">${result.error ?? (zh ? '加载失败' : 'Failed to load')}</div>`
      return
    }

    const workspaces = result.workspaces as Array<{ workspaceId?: string; title?: string; path?: string }>
    if (workspaces.length === 0) {
      wsContainer.innerHTML = `<div style="color: var(--dsw-alias-label-secondary, #73777f); font-size: 12px;">${zh ? '没有工作区' : 'No workspaces'}</div>`
      return
    }

    wsContainer.innerHTML = ''
    const list = document.createElement('div')
    list.style.display = 'grid'
    list.style.gap = '4px'

    for (const ws of workspaces) {
      const wsItem = document.createElement('div')
      wsItem.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:6px 8px; background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03)); border-radius:6px;'

      const wsInfo = document.createElement('div')
      wsInfo.style.minWidth = '0'
      
      const wsTitle = document.createElement('div')
      wsTitle.style.fontSize = '12px'
      wsTitle.style.fontWeight = '500'
      wsTitle.textContent = ws.title || ws.path || ws.workspaceId || 'Unknown'
      wsInfo.appendChild(wsTitle)

      if (ws.path) {
        const wsPath = document.createElement('div')
        wsPath.style.fontSize = '11px'
        wsPath.style.color = 'var(--dsw-alias-label-secondary, #73777f)'
        wsPath.style.wordBreak = 'break-all'
        wsPath.textContent = ws.path
        wsInfo.appendChild(wsPath)
      }

      wsItem.appendChild(wsInfo)

      const openBtn = document.createElement('button')
      openBtn.type = 'button'
      openBtn.textContent = zh ? '打开' : 'Open'
      openBtn.style.cssText = 'height:24px; padding:0 8px; font-size:11px; border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius:5px; background:transparent; color:inherit; cursor:pointer; flex:none;'
      openBtn.addEventListener('click', () => {
        // 打开远程工作区 - 在新窗口中打开远程 Harness 并定位到该工作区
        const entry = entries.find(e => e.id === id)
        if (entry) {
          // 构建工作区 URL（假设远程 Harness 支持 /workspace/:id 路径）
          const wsUrl = `${entry.baseUrl}/?workspace=${encodeURIComponent(ws.workspaceId || '')}`
          window.open(wsUrl, '_blank', 'noopener,noreferrer')
        }
      })
      wsItem.appendChild(openBtn)

      list.appendChild(wsItem)
    }

    wsContainer.appendChild(list)
    wsContainer.dataset.loaded = 'true'
  } catch (error) {
    wsContainer.innerHTML = `<div style="color: #e34d59; font-size: 12px;">${error instanceof Error ? error.message : String(error)}</div>`
  }
}

async function onRemove(id: string, item: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const zh = locale() === 'zh'
  btn.disabled = true
  btn.textContent = zh ? '删除中…' : 'Removing…'
  try {
    const ok = await api.remove(id)
    if (ok) {
      entries = entries.filter(e => e.id !== id)
      item.remove()
      if (entries.length === 0 && listEl) {
        renderList()
      }
    } else {
      btn.disabled = false
      btn.textContent = zh ? '删除' : 'Remove'
    }
  } catch {
    btn.disabled = false
    btn.textContent = zh ? '删除' : 'Remove'
  }
}
