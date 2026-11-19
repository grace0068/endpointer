// 전체 실행 검증 — 진짜 프로세스 · 진짜 큐로 한 바퀴 (수동 실행 스크립트, 회귀 테스트 아님)
//
//   node --import tsx scripts/full-run-check.ts      (cwd: apps/worker, Windows node)
//
// ── 실제로 띄우는 것 ──────────────────────────────────────────────────────
//  · 워커 프로세스(src/index.ts 그대로) — BullMQ 워커 4개 · 스케줄러 · HTTP 진입점
//  · 웹 앱(next start, 빌드본) — 화면에서 컬렉션 만들기 · 뷰 저장 · 알림 켜기 · 웹훅 등록 · 키 발급
//  · MCP 서버(src/index.ts 그대로)
//  · Redis — **1번 DB** 를 쓴다 (개발 큐가 있는 0번은 건드리지 않는다). 시작할 때 1번만 비운다
//  · Postgres — 테스트 DB(endpointer_test)
//  · Gemini — 진짜로 부른다 (컬렉션 만들 때 · 고칠 때만)
// ── 대체한 경계 ────────────────────────────────────────────────────────────
//  · 외부 사이트 → 이 스크립트가 띄우는 로컬 목록 사이트(127.0.0.1). 구조를 바꿔 "사이트 개편" 을 흉내 낸다
//  · 웹훅 수신처 → 로컬 수신 서버
//  · 사설 주소 차단 → 워커만 ALLOW_PRIVATE_HOSTS=true
//  · 로그인 → 데모 모드(모두 주인)
//  · "지금 수집" 버튼은 화면에 없다 — 정기 수집은 스케줄러로, 그 밖의 수집은 큐에 잡을 직접 넣는다

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { chromium, type Page } from 'playwright'

import { prepareTestDb, testDatabaseUrl } from '@endpointer/core/testing'

const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(WORKER_ROOT, '../..')
const OUT = path.join(REPO, '.cache', 'full-run')
mkdirSync(OUT, { recursive: true })

const REDIS_URL = 'redis://localhost:6379/1'
const TOKEN = 'full-run-check-internal-token'

// ── 결과 기록 ─────────────────────────────────────────────────────────────
type Verdict = 'pass' | 'fail' | 'note'
const results: { step: string; verdict: Verdict; detail: string }[] = []
function record(step: string, verdict: Verdict, detail: string): void {
  results.push({ step, verdict, detail })
  const mark = verdict === 'pass' ? '✔' : verdict === 'fail' ? '✘' : '•'
  console.log(`${mark} ${step} — ${detail}`)
}
function check(step: string, ok: boolean, detail: string): boolean {
  record(step, ok ? 'pass' : 'fail', detail)
  return ok
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 500): Promise<T> {
  const until = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < until) {
    try {
      const v = await fn()
      if (v !== null && v !== undefined && v !== false) return v
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`시간 초과: ${label}${last ? ` (${(last as Error).message})` : ''}`)
}

// ── 가짜 목록 사이트 ──────────────────────────────────────────────────────
interface Notice {
  id: number
  title: string
  date: string
  org: string
}
const notices: Notice[] = [
  { id: 101, title: '청년 창업 사업화 지원', date: '2026-12-31', org: '중소벤처기업부' },
  { id: 102, title: '중소기업 수출 바우처', date: '2026-12-20', org: '산업통상자원부' },
  { id: 103, title: '청년 디지털 일자리 지원', date: '2026-12-15', org: '고용노동부' },
  { id: 104, title: '소상공인 스마트상점 기술보급', date: '2026-12-10', org: '중소벤처기업부' },
  { id: 105, title: '탄소중립 설비 융자', date: '2026-12-28', org: '환경부' },
  { id: 106, title: '청년 연구자 초기 연구비', date: '2027-01-15', org: '과학기술정보통신부' },
  { id: 107, title: '지역 특화 관광 상품 공모', date: '2026-12-05', org: '문화체육관광부' },
  { id: 108, title: '농식품 벤처 육성 지원', date: '2027-01-10', org: '농림축산식품부' },
  { id: 109, title: '해외 전시회 참가 지원', date: '2026-12-18', org: '코트라' },
  { id: 110, title: '스마트공장 구축 지원', date: '2027-01-31', org: '중소벤처기업부' },
  { id: 111, title: '사회적기업 판로 지원', date: '2026-12-22', org: '고용노동부' },
  { id: 112, title: '콘텐츠 제작 지원 공모', date: '2027-01-05', org: '한국콘텐츠진흥원' },
]
let siteMode: 'v1' | 'v2' | 'down' | 'slow' = 'v1'
let siteHits = 0

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}
function renderV1(): string {
  const rows = notices
    .map(
      (n) =>
        `<li class="board-item"><a class="subject" href="/notice/${n.id}">${esc(n.title)}</a>` +
        `<span class="period">접수마감 ${n.date}</span><span class="org">${esc(n.org)}</span></li>`,
    )
    .join('\n')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>지원사업 공고</title></head><body>
<header><nav><a href="/">홈</a> <a href="/about">소개</a> <a href="/faq">자주 묻는 질문</a></nav></header>
<main><h1>지원사업 공고 목록</h1><ul class="board-list">\n${rows}\n</ul></main><footer>가짜 공고 사이트</footer></body></html>`
}
/** 사이트 개편 — 같은 공고, 다른 마크업 */
function renderV2(): string {
  const rows = notices
    .map(
      (n) =>
        `<article class="notice-card"><h3 class="tit"><a href="/notice/${n.id}">${esc(n.title)}</a></h3>` +
        `<p class="meta"><em class="deadline">${n.date.replace(/-/g, '.')}</em> · <b class="agency">${esc(n.org)}</b></p></article>`,
    )
    .join('\n')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>지원사업 공고</title></head><body>
<div class="gnb"><a href="/">홈</a> <a href="/about">소개</a> <a href="/faq">자주 묻는 질문</a></div>
<section class="contents"><h2>공고 안내</h2><div class="notice-grid">\n${rows}\n</div></section><footer>가짜 공고 사이트</footer></body></html>`
}

// ── 웹훅 수신 ─────────────────────────────────────────────────────────────
const hooks: { body: Record<string, unknown>; at: number }[] = []

function listen(server: Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))
}

// ── 프로세스 ──────────────────────────────────────────────────────────────
function launch(name: string, cwd: string, args: string[], env: Record<string, string>): ChildProcess {
  const log = createWriteStream(path.join(OUT, `${name}.log`), { flags: 'a' })
  log.write(`\n===== ${new Date().toISOString()} 시작 =====\n`)
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  return child
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.once('exit', (c) => r(c))))
}

async function main(): Promise<void> {
  const status = await prepareTestDb()
  if (!status.ok) throw new Error(`테스트 DB 준비 실패: ${JSON.stringify(status)}`)
  const DB = testDatabaseUrl() as string
  process.env['DATABASE_URL'] = DB
  const { queryClient: sql } = await import('@endpointer/core/db')

  // Redis 1번만 비운다
  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  await redis.flushdb()
  const prefix = 'endpointer'
  const collectQ = new Queue('collect', { connection: redis, prefix })
  const healQ = new Queue('heal', { connection: redis, prefix })
  const evaluateQ = new Queue('evaluate', { connection: redis, prefix })
  const deliverQ = new Queue('deliver', { connection: redis, prefix })

  // 가짜 사이트 · 웹훅
  const site = createServer((req, res) => {
    siteHits += 1
    if (req.url?.startsWith('/notice/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body><h1>공고 상세</h1></body></html>')
      return
    }
    if (siteMode === 'down') {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('maintenance')
      return
    }
    const send = () => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(siteMode === 'v2' ? renderV2() : renderV1())
    if (siteMode === 'slow') setTimeout(send, 8_000)
    else send()
  })
  const hookServer = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        hooks.push({ body: JSON.parse(raw) as Record<string, unknown>, at: Date.now() })
      } catch {
        hooks.push({ body: { raw }, at: Date.now() })
      }
      res.writeHead(200).end('ok')
    })
  })
  const sitePort = await listen(site)
  const hookPort = await listen(hookServer)
  const SITE_URL = `http://127.0.0.1:${sitePort}/notices`
  const HOOK_URL = `http://127.0.0.1:${hookPort}/hook`

  const free = async () => {
    const s = createServer()
    const p = await listen(s)
    await new Promise((r) => s.close(r))
    return p
  }
  const workerHttpPort = await free()
  const webPort = await free()
  const mcpPort = await free()

  const workerEnv = {
    DATABASE_URL: DB,
    REDIS_URL,
    ALLOW_PRIVATE_HOSTS: 'true',
    WORKER_INTERNAL_TOKEN: TOKEN,
    WORKER_HTTP_PORT: String(workerHttpPort),
    CRAWLER_CACHE_TTL_S: '0',
    CRAWLER_MIN_INTERVAL_MS: '300',
    LOG_LEVEL: 'info',
  }
  const startWorker = async () => {
    const w = launch('worker', WORKER_ROOT, ['--import', 'tsx', 'src/index.ts'], workerEnv)
    await waitFor('워커 HTTP', async () => (await fetch(`http://127.0.0.1:${workerHttpPort}/healthz`)).ok, 60_000)
    return w
  }
  let worker = await startWorker()
  record('기동', 'pass', `워커(HTTP ${workerHttpPort}) · Redis db1 · 테스트 DB`)

  const webRoot = path.join(REPO, 'apps', 'web')
  const nextBin = path.join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
  const web = launch('web', webRoot, [nextBin, 'start', '-p', String(webPort), '-H', '127.0.0.1'], {
    DATABASE_URL: DB,
    WORKER_INTERNAL_URL: `http://127.0.0.1:${workerHttpPort}`,
    WORKER_INTERNAL_TOKEN: TOKEN,
    // 로그인은 데모 모드로 고정 — 루트 .env 의 구글 키와 무관하게 (dotenv 는 이미 있는 키를 덮지 않는다)
    AUTH_GOOGLE_ID: '',
    AUTH_GOOGLE_SECRET: '',
  })
  const WEB = `http://127.0.0.1:${webPort}`
  await waitFor('웹', async () => (await fetch(WEB)).status < 500, 90_000)
  const mcp = launch('mcp', path.join(REPO, 'apps', 'mcp'), ['--import', 'tsx', 'src/index.ts'], {
    DATABASE_URL: DB,
    MCP_PORT: String(mcpPort),
    PUBLIC_MCP_BASE_URL: `http://127.0.0.1:${mcpPort}`,
  })
  const MCP = `http://127.0.0.1:${mcpPort}`
  await waitFor('MCP', async () => (await fetch(`${MCP}/healthz`)).ok, 60_000)
  record('기동', 'pass', `웹 ${webPort} · MCP ${mcpPort} · 가짜 사이트 ${sitePort} · 웹훅 ${hookPort}`)

  // 일일 뷰 평가 스케줄이 등록됐나
  const evalSchedulers = await evaluateQ.getJobSchedulers(0, -1, true)
  check('스케줄 · 일일 뷰 평가', evalSchedulers.some((s) => s.key === 'views:daily' && s.pattern === '5 0 * * *'), JSON.stringify(evalSchedulers.map((s) => [s.key, s.pattern, s.tz])))

  const browser = await chromium.launch()
  const context = await browser.newContext()
  await context.addInitScript(() => {
    for (const id of ['console', 'collection']) localStorage.setItem(`ep:tour:${id}`, 'skipped')
  })
  const page: Page = await context.newPage()

  // ════ 1. 화면에서 컬렉션 만들기 → 워커 HTTP → Gemini → 저장 · 첫 수집 · 스케줄 ════
  await page.goto(`${WEB}/collections/new`)
  await page.locator('#create-url').fill(SITE_URL)
  await page.getByRole('button', { name: '담기', exact: true }).click()
  let t0 = Date.now()
  await page.getByRole('button', { name: '컬렉션 만들기 →' }).click()
  await waitFor('미리보기', async () => (await page.locator('#create-name').count()) > 0, 240_000, 1_000)
  const previewRows = await page.locator('table tbody tr').count()
  record('1 만들기 · 미리보기', 'pass', `${((Date.now() - t0) / 1000).toFixed(1)}초 · 미리보기 ${previewRows}행 · 이름 "${await page.locator('#create-name').inputValue()}"`)
  await page.locator('#create-name').fill('전체 실행 검증')
  t0 = Date.now()
  await page.getByRole('button', { name: '이 표로 컬렉션 만들기' }).click()
  await page.waitForURL(/\/collections\/[^/]+\/table/, { timeout: 240_000 })
  const slug = (/\/collections\/([^/]+)\/table/.exec(page.url()) ?? [])[1] as string
  record('1 만들기 · 저장', 'pass', `${((Date.now() - t0) / 1000).toFixed(1)}초 · /collections/${slug}/table`)

  const col = (await sql<{ id: string; schema_json: { key: string; label: string; type: string }[]; visibility: string }[]>`
    select id, schema_json, visibility from collections where slug = ${slug}`)[0]!
  const src = (await sql<{ id: string; host: string; status: string; schedule: string }[]>`
    select id, host, status, schedule from sources where collection_id = ${col.id}`)[0]!
  const adapters1 = await sql<{ version: number; origin: string; status: string }[]>`
    select version, origin, status from adapters where source_id = ${src.id} order by version`
  const items1 = await sql<{ n: number }[]>`select count(*)::int n from items where collection_id = ${col.id}`
  const runs1 = await sql<{ status: string; items_found: number; items_new: number }[]>`
    select status, items_found, items_new from runs where source_id = ${src.id} order by started_at`
  check('1 만들기 · DB', items1[0]?.n === notices.length && adapters1.length === 1 && adapters1[0]?.status === 'active',
    `칸 ${col.schema_json.map((f) => `${f.key}:${f.type}`).join(', ')} · 항목 ${items1[0]?.n}/${notices.length} · 읽는 방법 ${JSON.stringify(adapters1)} · 수집 기록 ${JSON.stringify(runs1)}`)
  const sched1 = await collectQ.getJobSchedulers(0, -1, true)
  check('1 만들기 · 정기 수집 등록', sched1.some((s) => s.key === `source:${src.id}` && s.pattern === src.schedule),
    `${sched1.length}개 중 이 사이트 ${JSON.stringify(sched1.filter((s) => s.key === `source:${src.id}`).map((s) => [s.pattern, s.tz]))} (DB ${src.schedule})`)

  // ════ 2. 스케줄러가 스스로 수집을 민다 — 5초 주기로 바꾸고 워커 재시작(부팅 동기화) ════
  await sql`update sources set schedule = '*/5 * * * * *' where id = ${src.id}`
  worker.kill()
  await exited(worker)
  worker = await startWorker()
  const runsBefore = (await sql<{ n: number }[]>`select count(*)::int n from runs where source_id = ${src.id}`)[0]!.n
  const sched2 = await collectQ.getJobSchedulers(0, -1, true)
  check('2 스케줄 · 부팅 동기화', sched2.some((s) => s.key === `source:${src.id}` && s.pattern === '*/5 * * * * *'), `${sched2.length}개 등록 · 이 사이트 ${sched2.find((s) => s.key === `source:${src.id}`)?.pattern}`)
  const scheduledRuns = await waitFor('스케줄 수집 2회', async () => {
    const n = (await sql<{ n: number }[]>`select count(*)::int n from runs where source_id = ${src.id} and finished_at is not null`)[0]!.n
    return n >= runsBefore + 2 ? n : null
  }, 40_000)
  const lastRuns = await sql<{ status: string; items_new: number }[]>`
    select status, items_new from runs where source_id = ${src.id} order by started_at desc limit 2`
  check('2 스케줄 · 아무도 안 밀어도 돈다', lastRuns.every((r) => r.status === 'ok' && r.items_new === 0), `수집 기록 ${runsBefore}→${scheduledRuns} · 최근 ${JSON.stringify(lastRuns)}`)
  // 원래 주기로 되돌린다 (이후 단계는 큐에 직접 넣어 통제한다)
  await sql`update sources set schedule = ${src.schedule} where id = ${src.id}`
  worker.kill()
  await exited(worker)
  worker = await startWorker()
  const sched3 = await collectQ.getJobSchedulers(0, -1, true)
  check('2 스케줄 · 되돌리기', sched3.find((s) => s.key === `source:${src.id}`)?.pattern === src.schedule, `${sched3.length}개 중 이 사이트: ${sched3.find((s) => s.key === `source:${src.id}`)?.pattern}`)

  // ════ 3. 화면에서 뷰 저장 · 알림 켜기 · 웹훅 등록 · 키 발급 ════
  await page.goto(`${WEB}/collections/${slug}/table?q=${encodeURIComponent('청년')}`)
  await page.locator('#save-view-name').fill('청년 공고')
  await page.getByRole('button', { name: '이 조건 저장' }).click()
  await page.waitForURL(/view=/)
  const viewSlug = new URL(page.url()).searchParams.get('view') as string
  const youthBefore = notices.filter((n) => n.title.includes('청년')).length
  await page.goto(`${WEB}/collections/${slug}/views`)
  await page.getByRole('button', { name: '알림 켜기' }).first().click()
  await waitFor('알림 켜짐', async () => (await page.getByRole('button', { name: '알림 끄기' }).count()) > 0, 15_000)
  await page.locator('#subscribe-target').fill(HOOK_URL)
  await page.locator('#subscribe-target').press('Enter')
  await waitFor('웹훅 등록', async () => (await sql`select 1 from subscriptions where collection_id = ${col.id} and target = ${HOOK_URL}`).length > 0, 15_000)
  const viewRow = (await sql<{ search_q: string; notify_json: unknown }[]>`select search_q, notify_json from views where collection_id = ${col.id} and slug = ${viewSlug}`)[0]
  check('3 화면 설정', viewRow?.search_q === '청년' && viewRow.notify_json !== null, `뷰 ${viewSlug} ${JSON.stringify(viewRow)} · 웹훅 등록됨 · 지금 맞는 항목 ${youthBefore}개`)

  await page.goto(`${WEB}/collections/${slug}/connect`)
  await page.getByRole('button', { name: '키 만들기' }).click()
  const apiKey = await waitFor('키 표시', async () => /ep_[A-Za-z0-9_-]{43}/.exec(await page.content())?.[0] ?? null, 15_000)
  record('3 키 발급', 'pass', `${apiKey.slice(0, 7)}… (비공개 컬렉션: ${col.visibility})`)

  // ════ 4. 새 공고 → 수집(큐) → 평가(큐) → 발송(큐) → 웹훅 ════
  notices.push({ id: 113, title: '청년 데이터 바우처', date: '2027-01-20', org: '과학기술정보통신부' })
  notices.push({ id: 114, title: '중장년 재취업 훈련', date: '2027-01-25', org: '고용노동부' })
  const hooksBefore = hooks.length
  const job = await collectQ.add(`collect:${src.host}`, { source_id: src.id, collection_id: col.id, host: src.host, reason: 'manual' })
  const collectDone = await waitFor('수집 잡 완료', async () => {
    const st = await job.getState()
    return st === 'completed' || st === 'failed' ? st : null
  }, 60_000)
  const collectRes = (await collectQ.getJob(job.id as string))?.returnvalue
  check('4 수집 잡', collectDone === 'completed' && collectRes?.items_new === 2, `${collectDone} · ${JSON.stringify(collectRes)}`)
  await waitFor('웹훅 도착', async () => hooks.length > hooksBefore, 30_000)
  await new Promise((r) => setTimeout(r, 2_000)) // 늦게 오는 중복이 있는지 잠깐 더 본다
  const got = hooks.slice(hooksBefore)
  const sentTitles = got.flatMap((h) => ((h.body['items'] as Record<string, unknown>[] | undefined) ?? []).map((i) => JSON.stringify(i).match(/청년[^"]*|중장년[^"]*/)?.[0] ?? '?'))
  const counts = {
    evaluate: await evaluateQ.getJobCounts('completed', 'failed'),
    deliver: await deliverQ.getJobCounts('completed', 'failed'),
  }
  check('4 웹훅 · 새로 들어온 것만', got.length === 1 && sentTitles.length === 1 && sentTitles[0] === '청년 데이터 바우처',
    `웹훅 ${got.length}번 · 항목 ${sentTitles.length}개 ${JSON.stringify(sentTitles)} · 큐 ${JSON.stringify(counts)}`)
  writeFileSync(path.join(OUT, 'webhook-1.json'), JSON.stringify(got, null, 2))
  const deliveries = await sql<{ status: string; n: number }[]>`
    select d.status, cardinality(d.item_ids) n from deliveries d join subscriptions s on s.id = d.subscription_id where s.collection_id = ${col.id}`
  record('4 발송 기록', 'note', JSON.stringify(deliveries))

  // ════ 5. 세 출구 — REST(키) · MCP(키) · 웹 표가 같은 것을 낸다 ════
  const rest = await fetch(`${WEB}/api/v1/${slug}?view=${viewSlug}&limit=50`, { headers: { authorization: `Bearer ${apiKey}` } })
  const restBody = (await rest.json()) as { items: unknown[]; page: { total: number } }
  const restNoKey = await fetch(`${WEB}/api/v1/${slug}`)
  const mcpCall = async (method: string, params: unknown) => {
    const r = await fetch(`${MCP}/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await r.text()
    const data = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : text
    return { status: r.status, json: JSON.parse(data) as { result?: { tools?: { name: string }[]; structuredContent?: { page: { total: number } } } } }
  }
  const tools = await mcpCall('tools/list', {})
  const toolNames = tools.json.result?.tools?.map((t) => t.name) ?? []
  const viewTool = toolNames.find((n) => !['list_items', 'search_items', 'get_schema', 'get_sources_status'].includes(n))
  const mcpView = viewTool ? await mcpCall('tools/call', { name: viewTool, arguments: {} }) : null
  const mcpTotal = mcpView?.json.result?.structuredContent?.page.total
  await page.goto(`${WEB}/collections/${slug}/table?view=${viewSlug}`)
  const webRange = await page.locator('p[aria-live="polite"]').innerText()
  const expectYouth = notices.filter((n) => n.title.includes('청년')).length
  check('5 세 출구', rest.status === 200 && restBody.page.total === expectYouth && mcpTotal === expectYouth && webRange.includes(`전체 ${expectYouth}개`) && restNoKey.status === (col.visibility === 'private' ? 401 : 200),
    `기대 ${expectYouth} · REST ${rest.status}/${restBody.page.total} (공개범위 ${col.visibility} · 키 없이 ${restNoKey.status}) · MCP 도구 ${JSON.stringify(toolNames)} → ${mcpTotal} · 웹 "${webRange.replace(/\s+/g, ' ')}"`)

  // ════ 6. 사이트 개편 → 드리프트 → 격리 → 치유(큐 · Gemini) → 승격 → 기록 ════
  siteMode = 'v2'
  const job6 = await collectQ.add(`collect:${src.host}`, { source_id: src.id, collection_id: col.id, host: src.host, reason: 'manual' })
  await waitFor('드리프트 수집 완료', async () => ((await job6.getState()) === 'completed' ? true : null), 60_000)
  const driftRes = (await collectQ.getJob(job6.id as string))?.returnvalue
  const srcDuring = (await sql<{ status: string }[]>`select status from sources where id = ${src.id}`)[0]?.status
  const restDuring = (await (await fetch(`${WEB}/api/v1/${slug}?limit=50`, { headers: { authorization: `Bearer ${apiKey}` } })).json()) as { page: { total: number }; sources: Record<string, { status: string }> }
  check('6 드리프트 · 격리', driftRes?.status !== 'ok' && srcDuring === 'healing' && restDuring.page.total === notices.length,
    `수집 ${JSON.stringify(driftRes)} · 사이트 상태 ${srcDuring} · 고치는 동안 REST 항목 ${restDuring.page.total} (지우지 않음) · 출처 ${JSON.stringify(restDuring.sources)}`)
  t0 = Date.now()
  const healOutcome = await waitFor('치유 끝', async () => {
    const c = await healQ.getJobCounts('completed', 'failed', 'active', 'waiting')
    if ((c['active'] ?? 0) + (c['waiting'] ?? 0) > 0) return null
    if ((c['completed'] ?? 0) + (c['failed'] ?? 0) === 0) return null
    const jobs = await healQ.getJobs(['completed', 'failed'])
    return jobs.map((j) => ({ state: j.failedReason ? 'failed' : 'completed', ret: j.returnvalue, err: j.failedReason }))
  }, 300_000, 2_000)
  const adapters2 = await sql<{ version: number; origin: string; status: string }[]>`
    select version, origin, status from adapters where source_id = ${src.id} order by version`
  const healRuns = await sql<{ status: string; items_found: number; error_summary: string | null }[]>`
    select status, items_found, error_summary from runs where source_id = ${src.id} order by started_at desc limit 3`
  const srcAfter = (await sql<{ status: string }[]>`select status from sources where id = ${src.id}`)[0]?.status
  const itemsAfter = (await sql<{ n: number }[]>`select count(*)::int n from items where collection_id = ${col.id}`)[0]?.n
  check('6 치유 · 승격', srcAfter === 'ok' && adapters2.some((a) => a.origin === 'heal' && a.status === 'active') && itemsAfter === notices.length,
    `${((Date.now() - t0) / 1000).toFixed(1)}초 · 잡 ${JSON.stringify(healOutcome)} · 읽는 방법 ${JSON.stringify(adapters2)} · 최근 기록 ${JSON.stringify(healRuns)} · 사이트 ${srcAfter} · 항목 ${itemsAfter} (중복 생김 없음?)`)
  // 고친 뒤 정기 수집이 새 방법으로 도는가
  notices.push({ id: 115, title: '청년 해외 인턴십', date: '2027-02-10', org: '산업통상자원부' })
  const hooksBefore7 = hooks.length
  const job7 = await collectQ.add(`collect:${src.host}`, { source_id: src.id, collection_id: col.id, host: src.host, reason: 'manual' })
  await waitFor('고친 뒤 수집', async () => ((await job7.getState()) === 'completed' ? true : null), 60_000)
  const afterHealRes = (await collectQ.getJob(job7.id as string))?.returnvalue
  await waitFor('고친 뒤 웹훅', async () => hooks.length > hooksBefore7, 30_000).catch(() => null)
  await new Promise((r) => setTimeout(r, 2_000))
  const got7 = hooks.slice(hooksBefore7)
  check('6 고친 뒤 수집 · 알림', afterHealRes?.status === 'ok' && afterHealRes.items_new === 1 && got7.length === 1,
    `${JSON.stringify(afterHealRes)} · 웹훅 ${got7.length}번 ${JSON.stringify(got7.map((h) => (h.body['items'] as unknown[] | undefined)?.length))}`)
  writeFileSync(path.join(OUT, 'webhook-2.json'), JSON.stringify(got7, null, 2))

  // ════ 7. 사이트 장애 → 실패 기록 · 문구 · 재시도 ════
  siteMode = 'down'
  const job8 = await collectQ.add(`collect:${src.host}`, { source_id: src.id, collection_id: col.id, host: src.host, reason: 'manual' })
  await waitFor('장애 수집', async () => {
    const st = await job8.getState()
    return st === 'completed' || st === 'failed' || ((await collectQ.getJob(job8.id as string))?.attemptsMade ?? 0) > 0 ? st : null
  }, 60_000)
  await new Promise((r) => setTimeout(r, 3_000))
  const downRun = (await sql<{ status: string; error_summary: string | null }[]>`
    select status, error_summary from runs where source_id = ${src.id} order by started_at desc limit 1`)[0]
  const downJob = await collectQ.getJob(job8.id as string)
  const healAfterDown = await healQ.getJobCounts('completed', 'failed', 'active', 'waiting')
  const leaks = /\b(503|HTTP|adapter|spec|drift|어댑터|스펙|드리프트|파서)\b/i.test(downRun?.error_summary ?? '')
  check('7 장애 · 상태 문구', downRun !== undefined && downRun.status !== 'ok' && !leaks,
    `기록 ${JSON.stringify(downRun)} · 잡 상태 ${await downJob?.getState()} 시도 ${downJob?.attemptsMade} · 치유 큐 ${JSON.stringify(healAfterDown)}`)
  // 장애 중 치유가 돌았다면 끝날 때까지 기다린다
  await waitFor('장애 치유 정리', async () => {
    const c = await healQ.getJobCounts('active', 'waiting')
    return (c['active'] ?? 0) + (c['waiting'] ?? 0) === 0
  }, 120_000, 2_000).catch(() => null)
  const srcDown = (await sql<{ status: string }[]>`select status from sources where id = ${src.id}`)[0]?.status
  record('7 장애 뒤 사이트 상태', 'note', `${srcDown} · 최근 기록 ${JSON.stringify(await sql`select status, error_summary from runs where source_id = ${src.id} order by started_at desc limit 3`)}`)
  siteMode = 'v2'
  const job9 = await collectQ.add(`collect:${src.host}`, { source_id: src.id, collection_id: col.id, host: src.host, reason: 'manual' })
  await waitFor('복구 수집', async () => ((await job9.getState()) === 'completed' ? true : null), 60_000)
  const srcRecovered = (await sql<{ status: string }[]>`select status from sources where id = ${src.id}`)[0]?.status
  check('7 사이트 복구 → 정상', srcRecovered === 'ok', `${JSON.stringify((await collectQ.getJob(job9.id as string))?.returnvalue)} · 사이트 ${srcRecovered}`)
  await collectQ.drain(true) // 재시도로 걸린 장애 잡이 남아 있으면 치운다

  // ════ 8. 수집 도중 프로세스가 죽으면 — 다음 부팅이 끝나지 못한 기록을 닫는다 ════
  siteMode = 'slow'
  await collectQ.add(`collect:${src.host}`, { source_id: src.id, collection_id: col.id, host: src.host, reason: 'manual' }, { attempts: 1 })
  await waitFor('수집 시작', async () => (await sql`select 1 from runs where source_id = ${src.id} and finished_at is null`).length > 0, 30_000)
  worker.kill() // Windows 에서는 강제 종료 — 정리 코드가 돌 기회가 없다
  await exited(worker)
  const dangling = (await sql<{ n: number }[]>`select count(*)::int n from runs where source_id = ${src.id} and finished_at is null`)[0]?.n
  siteMode = 'v2'
  worker = await startWorker()
  // 죽을 때 돌던 잡은 BullMQ 가 멈춘 잡(stalled)으로 보고 다시 돌린다 — 그걸 기다린다
  const stalledRedo = await waitFor('멈춘 잡 재실행', async () => {
    const c = await collectQ.getJobCounts('completed', 'failed', 'active', 'waiting', 'delayed')
    // delayed 에는 반복 스케줄의 다음 차례가 늘 들어 있다 — 진행 중·대기만 본다
    return (c['active'] ?? 0) + (c['waiting'] ?? 0) === 0 ? c : null
  }, 90_000, 2_000).catch(() => null)
  const danglingNow = (await sql<{ n: number }[]>`select count(*)::int n from runs where source_id = ${src.id} and finished_at is null`)[0]?.n
  record('8 강제 종료 → 바로 재시작', danglingNow === 0 ? 'pass' : 'note',
    `죽기 직전 끝나지 않은 기록 ${dangling} → 재시작 직후에도 ${danglingNow}개 남음 (부팅 정리는 30분 넘은 것만 닫는다) · 멈춘 잡 재실행 ${JSON.stringify(stalledRedo)}`)
  // 30분 넘게 버려진 것처럼 시각을 당기고 다시 부팅 — 부팅 정리가 닫는가
  await sql`update runs set started_at = started_at - interval '31 minutes' where source_id = ${src.id} and finished_at is null`
  worker.kill()
  await exited(worker)
  worker = await startWorker()
  const closedRows = await sql<{ status: string; error_summary: string | null; finished_at: Date | null }[]>`
    select status, error_summary, finished_at from runs where source_id = ${src.id} and started_at < now() - interval '30 minutes' order by started_at desc limit 1`
  check('8 30분 지난 기록 → 부팅 정리', dangling === 1 && closedRows[0]?.finished_at !== null && closedRows[0]?.status === 'failed',
    JSON.stringify(closedRows[0]))

  // ── 화면의 수집 기록 ─────────────────────────────────────────────────
  await page.goto(`${WEB}/collections/${slug}/table`)
  await page.screenshot({ path: path.join(OUT, 'table.png'), fullPage: true })

  // ── 정리 ──────────────────────────────────────────────────────────────
  await browser.close()
  worker.kill()
  web.kill()
  mcp.kill()
  await Promise.all([collectQ.close(), healQ.close(), evaluateQ.close(), deliverQ.close()])
  redis.disconnect()
  site.close()
  hookServer.close()
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), slug, siteHits, results }, null, 2))
  const failed = results.filter((r) => r.verdict === 'fail').length
  console.log(`\n${results.filter((r) => r.verdict === 'pass').length} 통과 · ${failed} 실패 — ${path.join(OUT, 'results.json')}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('중단:', (e as Error).message)
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ aborted: (e as Error).message, results }, null, 2))
  process.exit(2)
})
