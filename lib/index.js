/**
 * dshos-dock — Workspace OS status bar for DeepSeek Harness (DSH).
 *
 * Host half: registers a read-only JSON endpoint at /dshos/status that
 * aggregates a small workspace "operating system" state: kernel status,
 * task list (one JSON file per task), a rolling event log, and the latest
 * checklist/audit note. The client half renders the compact status bar
 * above the conversation input.
 *
 * Data sources are resolved in order:
 *   1. config.root        — an explicit absolute path (cordis patch config)
 *   2. <cwd>/.dshos/      — the generic contract layout (see README)
 *   3. <cwd>/操作系统 + <cwd>/状态  — legacy DSH-OS layout (back-compat)
 * If none exist the endpoint still answers with ready:false so the client
 * shows a friendly "not initialized" hint instead of an empty bar.
 *
 * Zero runtime dependencies. Read-only: this plugin never writes files.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dshos-dock'
export const inject = ['webServer']

const KERNEL = 'dshos-dock'

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function readLinesSafe(p) {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}
function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !/[/\\]/.test(name)
}

/** Resolve which data-source layout to use for a workspace root. */
function resolveLayout(root, config) {
  if (config && typeof config.root === 'string' && config.root.length > 0) {
    if (existsSync(config.root)) return { source: 'configured', dshos: config.root }
    return { source: 'configured-missing', dshos: config.root }
  }
  const generic = join(root, '.dshos')
  if (existsSync(generic)) return { source: '.dshos', dshos: generic }
  const osDir = join(root, '操作系统')
  const statusDir = join(root, '状态')
  if (existsSync(osDir) && existsSync(statusDir))
    return { source: 'dshos-layout', dshos: join(osDir, '..'), osDir, statusDir }
  return { source: 'none', dshos: null }
}

/** Pure aggregation; exported for tests. */
export function __collect(root, config = {}) {
  const layout = resolveLayout(root, config)
  const out = {
    at: new Date().toISOString(),
    kernel: KERNEL,
    ready: layout.source !== 'none' && layout.source !== 'configured-missing',
    source: layout.source,
    os: null,
    tasks: { total: 0, running: 0, awaiting: 0, list: [] },
    events: [],
    latestChecklist: null,
    listErr: null,
  }

  if (layout.source === '.dshos') {
    const os = readJsonSafe(join(layout.dshos, 'status.json'))
    if (os) out.os = { status: os.status || null, current_stage: os.current_stage || null }
    let tasks = []
    let listErr = null
    try {
      for (const name of readdirSync(join(layout.dshos, 'tasks'))) {
        if (!safeName(name) || !name.endsWith('.json')) continue
        const j = readJsonSafe(join(layout.dshos, 'tasks', name))
        if (j) tasks.push({
          project: j.project || name.replace(/\.json$/, ''),
          status: j.status || null,
          stage: j.current_stage || j.stage || null,
          updated_at: j.updated_at || null,
        })
      }
    } catch (e) { listErr = String(e && e.message || e) }
    tasks.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    out.tasks = {
      total: tasks.length,
      running: tasks.filter((t) => t.status === 'in_progress').length,
      awaiting: tasks.filter((t) => t.status === 'awaiting_acceptance' || t.status === 'pending_acceptance').length,
      list: tasks.slice(0, 8),
    }
    out.listErr = listErr
    out.events = readLinesSafe(join(layout.dshos, 'events.jsonl'))
      .split('\n').filter(Boolean).slice(-6)
      .map((l) => { try { const e = JSON.parse(l); return { ts: e.ts || null, event: e.event || null, task: e.task_id || null } } catch { return null } })
      .filter(Boolean)
    let latest = null
    try {
      const files = readdirSync(join(layout.dshos, 'checklists')).filter((f) => f.endsWith('.md')).sort()
      if (files.length) latest = files[files.length - 1]
    } catch { /* no checklist dir yet */ }
    out.latestChecklist = latest
  } else if (layout.source === 'dshos-layout') {
    const os = readJsonSafe(join(layout.osDir, 'workflow_status.json'))
    if (os) out.os = { status: os.status || null, current_stage: os.current_stage || null }
    let tasks = []
    let listErr = null
    try {
      for (const name of readdirSync(layout.statusDir)) {
        if (!safeName(name)) continue
        const j = readJsonSafe(join(layout.statusDir, name, 'workflow_status.json'))
        if (j) tasks.push({
          project: name,
          status: j.status || null,
          stage: j.current_stage || null,
          updated_at: j.updated_at || null,
        })
      }
    } catch (e) { listErr = String(e && e.message || e) }
    tasks.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    out.tasks = {
      total: tasks.length,
      running: tasks.filter((t) => t.status === 'in_progress').length,
      awaiting: tasks.filter((t) => t.status === 'awaiting_acceptance').length,
      list: tasks.slice(0, 8),
    }
    out.listErr = listErr
    out.events = readLinesSafe(join(layout.osDir, 'runtime', 'runs_log.jsonl'))
      .split('\n').filter(Boolean).slice(-6)
      .map((l) => { try { const e = JSON.parse(l); return { ts: e.ts || null, event: e.event || null, task: e.task_id || null } } catch { return null } })
      .filter(Boolean)
    let latest = null
    try {
      const files = readdirSync(join(layout.osDir, 'checklists')).filter((f) => f.endsWith('.md')).sort()
      if (files.length) latest = files[files.length - 1]
    } catch { /* no checklist dir yet */ }
    out.latestChecklist = latest
  }

  return out
}

function handler(config) {
  return function (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    try {
      const body = JSON.stringify(__collect(process.cwd(), config))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: String(e && e.message || e) }))
    }
  }
}

export function apply(ctx, config = {}) {
  if (!ctx.webServer) {
    ctx.logger?.warn?.('dshos-dock: webServer service unavailable, status route not registered')
    return
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/dshos/status', handler: handler(config) }),
    'dshos-dock: /dshos/status route',
  )
}
