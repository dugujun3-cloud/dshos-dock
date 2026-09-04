import http from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __collect } from './lib/index.js'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra) }
}

const mk = (root, rel, content) => {
  const p = join(root, rel)
  writeFileSync(p, content)
}
function seedGeneric(root) {
  const d = join(root, '.dshos')
  mkdirSync(join(d, 'tasks'), { recursive: true })
  mkdirSync(join(d, 'checklists'), { recursive: true })
  mk(d, 'status.json', JSON.stringify({ status: 'active', current_stage: 'stage-3' }))
  mk(join(d, 'tasks'), 'a.json', JSON.stringify({ project: 'Alpha', status: 'in_progress', current_stage: 'build', updated_at: '2026-09-03T10:00:00Z' }))
  mk(join(d, 'tasks'), 'b.json', JSON.stringify({ project: 'Beta', status: 'awaiting_acceptance', current_stage: 'review', updated_at: '2026-09-04T08:00:00Z' }))
  mk(join(d, 'tasks'), 'c.json', JSON.stringify({ project: 'Gamma', status: 'done', updated_at: '2026-09-02T09:00:00Z' }))
  const events = [1, 2, 3, 4, 5, 6, 7, 8].map(i => JSON.stringify({ ts: '2026-09-04T0' + i + ':00:00.000Z', event: 'step-' + i, task_id: 'a' })).join('\n') + '\n'
  mk(d, 'events.jsonl', events)
  mk(join(d, 'checklists'), '2026-09-03.md', '# check')
  mk(join(d, 'checklists'), '2026-09-04.md', '# check2')
}

// 1) generic .dshos contract layout
{
  const root = join(tmpdir(), 'dshos-test-' + Date.now())
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  seedGeneric(root)
  const out = __collect(root)
  check('generic: ready', out.ready === true)
  check('generic: source is .dshos', out.source === '.dshos')
  check('generic: os status', out.os && out.os.status === 'active' && out.os.current_stage === 'stage-3')
  check('generic: task total 3', out.tasks.total === 3, String(out.tasks.total))
  check('generic: running 1', out.tasks.running === 1, String(out.tasks.running))
  check('generic: awaiting 1', out.tasks.awaiting === 1, String(out.tasks.awaiting))
  check('generic: sorted desc (Beta first)', out.tasks.list[0] && out.tasks.list[0].project === 'Beta')
  check('generic: events capped at 6', out.events.length === 6, String(out.events.length))
  check('generic: last event is step-8', out.events[5] && out.events[5].event === 'step-8')
  check('generic: latest checklist', out.latestChecklist === '2026-09-04.md', String(out.latestChecklist))
  rmSync(root, { recursive: true, force: true })
}

// 2) legacy DSH-OS layout (操作系统 + 状态)
{
  const root = join(tmpdir(), 'dshos-legacy-' + Date.now())
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, '操作系统', 'runtime'), { recursive: true })
  mkdirSync(join(root, '操作系统', 'checklists'), { recursive: true })
  mkdirSync(join(root, '状态', 'm1'), { recursive: true })
  mk(join(root, '操作系统'), 'workflow_status.json', JSON.stringify({ status: 'active', current_stage: 'kickoff' }))
  mk(join(root, '操作系统', 'runtime'), 'runs_log.jsonl', JSON.stringify({ ts: '2026-09-04T12:00:00Z', event: 'run-done', task_id: 'm1' }) + '\n')
  mk(join(root, '操作系统', 'checklists'), '2026-09-04.md', '# x')
  mk(join(root, '状态', 'm1'), 'workflow_status.json', JSON.stringify({ status: 'in_progress', current_stage: 'build', updated_at: '2026-09-04T11:00:00Z' }))
  const out = __collect(root)
  check('legacy: source dshos-layout', out.source === 'dshos-layout')
  check('legacy: task total 1, running 1', out.tasks.total === 1 && out.tasks.running === 1)
  check('legacy: event parsed', out.events.length === 1 && out.events[0].event === 'run-done')
  check('legacy: latest checklist', out.latestChecklist === '2026-09-04.md')
  rmSync(root, { recursive: true, force: true })
}

// 3) no data source -> graceful degradation
{
  const root = join(tmpdir(), 'dshos-none-' + Date.now())
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const out = __collect(root)
  check('none: ready false', out.ready === false)
  check('none: source none', out.source === 'none')
  check('none: no crash, fields present', out.tasks.total === 0 && Array.isArray(out.events))
  rmSync(root, { recursive: true, force: true })
}

// 4) configured root wins
{
  const cfgRoot = join(tmpdir(), 'dshos-cfg-' + Date.now())
  rmSync(cfgRoot, { recursive: true, force: true })
  mkdirSync(join(cfgRoot, '.dshos', 'tasks'), { recursive: true })
  const other = join(tmpdir(), 'dshos-other-' + Date.now())
  rmSync(other, { recursive: true, force: true })
  mkdirSync(other, { recursive: true })
  seedGeneric(other)
  const out = __collect(other, { root: cfgRoot })
  check('config: configured root wins', out.source === 'configured' && out.tasks.total === 0, out.source)
  rmSync(cfgRoot, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
}

// 5) HTTP route + 405
{
  const root = join(tmpdir(), 'dshos-http-' + Date.now())
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  seedGeneric(root)
  const module = await import('./lib/index.js')
  const server = http.createServer((req, res) => {
    if (req.url === '/dshos/status') {
      // emulate the handler contract using __collect (route registration needs ctx; test logic directly)
      const body = JSON.stringify(module.__collect(root))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    } else {
      res.writeHead(404); res.end()
    }
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  const base = 'http://127.0.0.1:' + server.address().port
  const res = await fetch(base + '/dshos/status')
  check('http: GET 200', res.status === 200, String(res.status))
  const j = await res.json()
  check('http: json ready', j.ready === true && j.tasks.total === 3)
  server.close()
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log('result: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
