/**
 * dshos-dock — Workspace OS status bar for DeepSeek Harness (DSH).
 *
 * Host half: registers a read-only JSON endpoint at /dshos/status that
 * aggregates a small workspace "operating system" state: kernel status,
 * task list (one JSON file per task), a rolling event log, and the latest
 * checklist/audit note. The client half renders the compact status bar
 * above the conversation input.
 *
 * Data resolution order (workspace root OR configured root):
 *   1. <root>/.dshos/                  — generic contract layout (see README)
 *   2. <root>/操作系统 + <root>/状态    — legacy DSH-OS layout (back-compat)
 * A configured root pointing straight at a .dshos-format directory is also
 * accepted. If nothing exists the endpoint answers ready:false so the
 * client shows a friendly "not initialized" hint.
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
  const bs = String.fromCharCode(92)
  return typeof name === 'string' && name.length > 0 && name.indexOf('/') < 0 && name.indexOf(bs) < 0
}

/**
 * Normalize a data source into { kind: 'contract' | 'legacy' | 'none',
 * source, dir?, osDir?, statusDir? }.
 * kind 'contract' → dir is the .dshos-format directory;
 * kind 'legacy'   → osDir/statusDir form the DSH-OS layout.
 */
function resolveRoot(root, config) {
  if (config && typeof config.root === 'string' && config.root.length > 0) {
    if (existsSync(join(config.root, '.dshos')))
      return { kind: 'contract', source: 'configured', dir: join(config.root, '.dshos') }
    const osDir = join(config.root, '操作系统')
    const statusDir = join(config.root, '状态')
    if (existsSync(osDir) && existsSync(statusDir))
      return { kind: 'legacy', source: 'configured-legacy', osDir, statusDir }
    if (existsSync(join(config.root, 'status.json')) || existsSync(join(config.root, 'tasks')) || existsSync(join(config.root, 'events.jsonl')))
      return { kind: 'contract', source: 'configured', dir: config.root }
    return { kind: 'none', source: 'configured-missing' }
  }
  const generic = join(root, '.dshos')
  if (existsSync(generic)) return { kind: 'contract', source: '.dshos', dir: generic }
  const osDir = join(root, '操作系统')
  const statusDir = join(root, '状态')
  if (existsSync(osDir) && existsSync(statusDir))
    return { kind: 'legacy', source: 'dshos-layout', osDir, statusDir }
  return { kind: 'none', source: 'none' }
}

/** Fill a contract-layout payload. */
function collectContract(out, dir) {
  const os = readJsonSafe(join(dir, 'status.json'))
  if (os) out.os = { status: os.status || null, current_stage: os.current_stage || null }
  let tasks = []
  let listErr = null
  try {
    for (const name of readdirSync(join(dir, 'tasks'))) {
      if (!safeName(name) || !name.endsWith('.json')) continue
      const j = readJsonSafe(join(dir, 'tasks', name))
      if (j) tasks.push({
        project: j.project || name.slice(0, -5),
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
  out.events = readLinesSafe(join(dir, 'events.jsonl'))
    .split(String.fromCharCode(10)).filter(Boolean).slice(-6)
    .map((l) => { try { const e = JSON.parse(l); return { ts: e.ts || null, event: e.event || null, task: e.task_id || null } } catch { return null } })
    .filter(Boolean)
  let latest = null
  try {
    const files = readdirSync(join(dir, 'checklists')).filter((f) => f.endsWith('.md')).sort()
    if (files.length) latest = files[files.length - 1]
  } catch { /* no checklist dir yet */ }
  out.latestChecklist = latest
}

/** Fill a legacy DSH-OS layout payload. */
function collectLegacy(out, osDir, statusDir) {
  const os = readJsonSafe(join(osDir, 'workflow_status.json'))
  if (os) out.os = { status: os.status || null, current_stage: os.current_stage || null }
  let tasks = []
  let listErr = null
  try {
    for (const name of readdirSync(statusDir)) {
      if (!safeName(name)) continue
      const j = readJsonSafe(join(statusDir, name, 'workflow_status.json'))
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
  out.events = readLinesSafe(join(osDir, 'runtime', 'runs_log.jsonl'))
    .split(String.fromCharCode(10)).filter(Boolean).slice(-6)
    .map((l) => { try { const e = JSON.parse(l); return { ts: e.ts || null, event: e.event || null, task: e.task_id || null } } catch { return null } })
    .filter(Boolean)
  let latest = null
  try {
    const files = readdirSync(join(osDir, 'checklists')).filter((f) => f.endsWith('.md')).sort()
    if (files.length) latest = files[files.length - 1]
  } catch { /* no checklist dir yet */ }
  out.latestChecklist = latest
}

/** Pure aggregation; exported for tests. */
export function __collect(root, config = {}) {
  const layout = resolveRoot(root, config)
  const out = {
    at: new Date().toISOString(),
    kernel: KERNEL,
    ready: layout.kind !== 'none',
    source: layout.source,
    os: null,
    tasks: { total: 0, running: 0, awaiting: 0, list: [] },
    events: [],
    latestChecklist: null,
    listErr: null,
  }
  if (layout.kind === 'contract') collectContract(out, layout.dir)
  else if (layout.kind === 'legacy') collectLegacy(out, layout.osDir, layout.statusDir)
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
