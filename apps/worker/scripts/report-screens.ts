// 보고서용 화면 캡처 — 전체 실행 검증(full-run-check.ts)이 남긴 컬렉션을 그대로 찍는다 (수동 실행)
//
//   node --import tsx scripts/report-screens.ts      (cwd: apps/worker, Windows node)
//
// 테스트 DB(endpointer_test)의 가장 최근 "전체 실행 검증" 컬렉션 — 만들기 · 스케줄 · 알림 · 개편·치유 ·
// 장애·복구 기록이 다 들어 있다. 빌드한 웹 앱을 그 DB 에 붙여 띄우고 Chromium 으로 찍는다.
// "만들기 미리보기" 화면만은 살아 있는 사이트와 워커가 필요해 로컬 목록 사이트와 워커를 같이 띄운다
// (Gemini 1회 · 저장은 누르지 않는다). 결과: docs/screenshots/<날짜>/*.png

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Page } from 'playwright'

import { prepareTestDb, testDatabaseUrl } from '@endpointer/core/testing'

const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(WORKER_ROOT, '../..')
const DAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
const OUT = path.join(REPO, 'docs', 'screenshots', DAY)
mkdirSync(OUT, { recursive: true })
const TOKEN = 'report-screens-internal-token'

function listen(server: Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))
}
async function freePort(): Promise<number> {
  const s = createServer()
  const p = await listen(s)
  await new Promise((r) => s.close(r))
  return p
}
async function waitUp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status < 500) return
    } catch {
      // 아직
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`안 떴다: ${url}`)
}
function launch(cwd: string, args: string[], env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' })
}

/** 가짜 공고 사이트 — full-run-check 와 같은 마크업 */
const NOTICES = [
  ['청년 창업 사업화 지원', '2026-12-31', '중소벤처기업부'],
  ['중소기업 수출 바우처', '2026-12-20', '산업통상자원부'],
  ['청년 디지털 일자리 지원', '2026-12-15', '고용노동부'],
  ['소상공인 스마트상점 기술보급', '2026-12-10', '중소벤처기업부'],
  ['탄소중립 설비 융자', '2026-12-28', '환경부'],
  ['청년 연구자 초기 연구비', '2027-01-15', '과학기술정보통신부'],
  ['지역 특화 관광 상품 공모', '2026-12-05', '문화체육관광부'],
  ['농식품 벤처 육성 지원', '2027-01-10', '농림축산식품부'],
  ['해외 전시회 참가 지원', '2026-12-18', '코트라'],
  ['스마트공장 구축 지원', '2027-01-31', '중소벤처기업부'],
] as const
function siteHtml(): string {
  const rows = NOTICES.map(
    ([t, d, o], i) =>
      `<li class="board-item"><a class="subject" href="/notice/${101 + i}">${t}</a><span class="period">접수마감 ${d}</span><span class="org">${o}</span></li>`,
  ).join('\n')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>지원사업 공고</title></head><body>
<header><nav><a href="/">홈</a> <a href="/about">소개</a></nav></header><main><h1>지원사업 공고 목록</h1><ul class="board-list">${rows}</ul></main></body></html>`
}

async function main(): Promise<void> {
  const status = await prepareTestDb()
  if (!status.ok) throw new Error('테스트 DB 에 닿지 못했다')
  const DB = testDatabaseUrl() as string
  process.env['DATABASE_URL'] = DB
  const { queryClient: sql } = await import('@endpointer/core/db')

  const col = (await sql<{ slug: string; name: string }[]>`
    select slug, name from collections where name = '전체 실행 검증' order by created_at desc limit 1`)[0]
  if (col === undefined) throw new Error('전체 실행 검증 컬렉션이 없다 — full-run-check.ts 를 먼저 돌린다')
  const view = (await sql<{ slug: string }[]>`
    select v.slug from views v join collections c on c.id = v.collection_id where c.slug = ${col.slug} limit 1`)[0]

  // 로컬 사이트 · 워커(미리보기용) · 웹
  const site = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url?.startsWith('/notice/') ? '<h1>상세</h1>' : siteHtml())
  })
  const sitePort = await listen(site)
  const workerPort = await freePort()
  const webPort = await freePort()
  const worker = launch(WORKER_ROOT, ['--import', 'tsx', 'src/index.ts'], {
    DATABASE_URL: DB,
    REDIS_URL: 'redis://localhost:6379/2', // 미리보기는 큐를 안 쓴다 — 검증 큐(1번)와도 분리
    ALLOW_PRIVATE_HOSTS: 'true',
    WORKER_INTERNAL_TOKEN: TOKEN,
    WORKER_HTTP_PORT: String(workerPort),
    LOG_LEVEL: 'warn',
  })
  const webRoot = path.join(REPO, 'apps', 'web')
  const web = launch(webRoot, [path.join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(webPort), '-H', '127.0.0.1'], {
    DATABASE_URL: DB,
    WORKER_INTERNAL_URL: `http://127.0.0.1:${workerPort}`,
    WORKER_INTERNAL_TOKEN: TOKEN,
    // 로그인은 데모 모드로 고정 — 루트 .env 의 구글 키와 무관하게 (dotenv 는 이미 있는 키를 덮지 않는다)
    AUTH_GOOGLE_ID: '',
    AUTH_GOOGLE_SECRET: '',
  })
  const WEB = `http://127.0.0.1:${webPort}`
  await Promise.all([waitUp(`http://127.0.0.1:${workerPort}/healthz`, 60_000), waitUp(WEB, 90_000)])

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ko-KR' })
  await context.addInitScript(() => {
    for (const id of ['console', 'collection']) localStorage.setItem(`ep:tour:${id}`, 'skipped')
  })
  const page: Page = await context.newPage()
  const shots: { file: string; title: string; url: string }[] = []

  async function p_contentHeight(p: Page): Promise<number> {
    return p.evaluate(() => {
      const scroller = [...document.querySelectorAll<HTMLElement>('div')].find((d) => getComputedStyle(d).overflowY === 'auto' && d.scrollHeight > d.clientHeight)
      return scroller ? scroller.scrollHeight : document.documentElement.scrollHeight
    })
  }

  async function shot(file: string, title: string, url: string, prepare?: (p: Page) => Promise<void>): Promise<void> {
    try {
      await page.goto(`${WEB}${url}`, { waitUntil: 'networkidle' })
      if (prepare) await prepare(page)
      await page.waitForTimeout(400)
      // 스크롤은 문서가 아니라 본문 칸(layout.tsx 의 overflow-y-auto)이 한다 — fullPage 로는 첫 화면만 찍힌다.
      // 본문 칸의 높이만큼 창을 늘려서 한 장에 담는다.
      const height = await p_contentHeight(page)
      await page.setViewportSize({ width: 1440, height: Math.max(900, Math.min(height, 6000)) })
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(OUT, file) })
      await page.setViewportSize({ width: 1440, height: 900 })
      shots.push({ file, title, url })
      console.log(`✔ ${file} — ${title}`)
    } catch (e) {
      console.log(`✘ ${file} — ${(e as Error).message.split('\n')[0]}`)
    }
  }

  const base = `/collections/${col.slug}`
  await shot('01-home.png', '첫 화면', '/')
  await shot('03-create-preview.png', '컬렉션 만들기 — 주소 하나로 채워진 표 미리보기', '/collections/new', async (p) => {
    await p.locator('#create-url').fill(`http://127.0.0.1:${sitePort}/notices`)
    await p.getByRole('button', { name: '담기', exact: true }).click()
    await p.getByRole('button', { name: '컬렉션 만들기 →' }).click()
    await p.locator('#create-name').waitFor({ timeout: 180_000 })
  })
  await shot('04-collection.png', '컬렉션 개요', base)
  await shot('05-table.png', '표 — 서버 검색·정렬·페이지', `${base}/table`)
  await shot('06-table-view.png', '저장한 조건(뷰)으로 본 표', `${base}/table${view ? `?view=${view.slug}` : ''}`)
  await shot('07-views.png', '저장한 조건 · 알림 켬 · 알림 받을 곳', `${base}/views`)
  await shot('08-sources.png', '사이트 상태 · 수집 기록 (자동 복구 포함)', `${base}/sources`)
  await shot('09-workshop.png', '작업실', `${base}/workshop`)
  await shot('10-feed.png', '피드', `${base}/feed`)
  await shot('11-connect.png', 'API · AI 연결', `${base}/connect`)
  await shot('12-settings.png', '설정 · 공유 안내', `${base}/settings`)

  writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ taken_at: new Date().toISOString(), collection: col, shots }, null, 2))
  await browser.close()
  worker.kill()
  web.kill()
  site.close()
  console.log(`\n${shots.length}장 — ${OUT}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('중단:', (e as Error).message)
  process.exit(1)
})
