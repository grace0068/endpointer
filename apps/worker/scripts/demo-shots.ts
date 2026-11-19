// 보고서용 — 개발 서버(localhost:3000)에서 실제 공모전 사이트로 컬렉션을 만들고 사이트를 합치며 찍는다 (수동 실행)
//
//   node --import tsx scripts/demo-shots.ts session            # 로그인 세션(개발 DB) 만들기
//   node --import tsx scripts/demo-shots.ts create <url> <이름>
//   node --import tsx scripts/demo-shots.ts attach <slug> <url> [붙여넣을 칸=값 ...]
//   node --import tsx scripts/demo-shots.ts shots <slug>
//   node --import tsx scripts/demo-shots.ts cleanup            # 세션 지우기
//
// 로그인: 구글 로그인을 자동화할 수 없어, 개발 DB 의 sessions 에 **본인 계정의 임시 세션**을 넣고
// 그 쿠키로 브라우저를 연다(Auth.js database 세션). 끝나면 cleanup 으로 지운다.

import '../src/config' // 루트 .env

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Page } from 'playwright'

const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(WORKER_ROOT, '../..')
const DAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
const OUT = path.join(REPO, 'docs', 'screenshots', DAY)
const STATE = path.join(REPO, '.cache', 'demo-shots')
mkdirSync(OUT, { recursive: true })
mkdirSync(STATE, { recursive: true })
const SESSION_FILE = path.join(STATE, 'session.json')
const WEB = 'http://localhost:3000'
const USER_NAME = '김희서'

const [cmd, ...args] = process.argv.slice(2)

async function sql() {
  return (await import('@endpointer/core/db')).queryClient
}

async function browserPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  if (!existsSync(SESSION_FILE)) throw new Error('세션이 없다 — session 부터')
  const { token } = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as { token: string }
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ko-KR' })
  await context.addCookies([{ name: 'authjs.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }])
  await context.addInitScript(() => {
    for (const id of ['console', 'collection']) localStorage.setItem(`ep:tour:${id}`, 'skipped')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  return { page, close: () => browser.close() }
}

/** 본문 칸(layout 의 overflow-y-auto) 높이만큼 창을 늘려 한 장에 담는다 */
async function shot(page: Page, file: string): Promise<void> {
  await page.waitForTimeout(500)
  const h = await page.evaluate(() => {
    const s = [...document.querySelectorAll<HTMLElement>('div')].find((d) => getComputedStyle(d).overflowY === 'auto' && d.scrollHeight > d.clientHeight)
    return s ? s.scrollHeight : document.documentElement.scrollHeight
  })
  await page.setViewportSize({ width: 1440, height: Math.max(900, Math.min(h, 7000)) })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, file) })
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log(`📸 ${file}`)
}

async function main(): Promise<void> {
  if (cmd === 'session') {
    const db = await sql()
    const users = await db<{ id: string }[]>`select id from users where name = ${USER_NAME}`
    if (users.length !== 1) throw new Error(`${USER_NAME} 계정을 하나로 찾지 못했다 (${users.length})`)
    const token = randomUUID()
    await db`insert into sessions ("sessionToken", "userId", expires) values (${token}, ${users[0]!.id}, now() + interval '1 day')`
    writeFileSync(SESSION_FILE, JSON.stringify({ token }))
    console.log('세션을 만들었다 (1일)')
    process.exit(0)
  }
  if (cmd === 'cleanup') {
    const db = await sql()
    if (existsSync(SESSION_FILE)) {
      const { token } = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as { token: string }
      const r = await db`delete from sessions where "sessionToken" = ${token}`
      writeFileSync(SESSION_FILE, '{}')
      console.log(`세션 ${r.count}개 지움`)
    }
    process.exit(0)
  }

  const { page, close } = await browserPage()
  try {
    if (cmd === 'create') {
      const [url, name] = args as [string, string]
      await page.goto(`${WEB}/collections/new`)
      await page.locator('#create-url').fill(url)
      await page.getByRole('button', { name: '담기', exact: true }).click()
      await page.getByRole('button', { name: '컬렉션 만들기 →' }).click()
      const t0 = Date.now()
      await Promise.race([
        page.locator('#create-name').waitFor({ timeout: 300_000 }),
        page.getByText(/못했어요|어려워요|실패/).first().waitFor({ timeout: 300_000 }),
      ])
      console.log(`미리보기 ${((Date.now() - t0) / 1000).toFixed(1)}초`)
      await shot(page, '10-create-preview.png')
      if ((await page.locator('#create-name').count()) === 0) throw new Error('미리보기를 받지 못했다 — 화면 문구를 본다')
      await page.locator('#create-name').fill(name)
      await page.getByRole('button', { name: '이 표로 컬렉션 만들기' }).click()
      await page.waitForURL(/\/collections\/[^/]+\/table/, { timeout: 300_000 })
      console.log(`만듦: ${page.url()}`)
      await shot(page, '11-created-table.png')
    } else if (cmd === 'attach') {
      const [slug, url, ...pastes] = args as [string, string, ...string[]]
      const n = Number(process.env['SHOT_N'] ?? '2')
      await page.goto(`${WEB}/collections/${slug}/attach`)
      await page.locator('#attach-url').fill(url)
      await page.getByRole('button', { name: '이 사이트 붙이기' }).click()
      const t0 = Date.now()
      await Promise.race([
        page.getByRole('button', { name: /표에 합류하기/ }).waitFor({ timeout: 300_000 }),
        page.getByText(/못했어요|어려워요/).first().waitFor({ timeout: 300_000 }),
      ])
      console.log(`맞춰보기 ${((Date.now() - t0) / 1000).toFixed(1)}초`)
      await shot(page, `2${n}-attach-${n}-match.png`)
      // 못 찾은 칸에 값을 붙여넣고 다시 맞춰본다 — 화면에서 사람이 하는 그대로
      if (pastes.length > 0) {
        for (const p of pastes) {
          const at = p.indexOf('=')
          await page.locator(`input[name="pasted_${p.slice(0, at)}"]`).fill(p.slice(at + 1))
        }
        await shot(page, `2${n}-attach-${n}-pasting.png`)
        await page.getByRole('button', { name: '이 값으로 찾기' }).click()
        await page.waitForTimeout(1000)
        await Promise.race([
          page.getByRole('button', { name: /표에 합류하기/ }).waitFor({ timeout: 300_000 }),
          page.getByText(/못했어요|어려워요/).first().waitFor({ timeout: 300_000 }),
        ])
        await shot(page, `2${n}-attach-${n}-pasted.png`)
      }
      if ((await page.getByRole('button', { name: /표에 합류하기/ }).count()) === 0) throw new Error('합류 버튼이 없다 — 화면 문구를 본다')
      await page.getByRole('button', { name: /표에 합류하기/ }).click()
      await page.waitForURL((u) => !u.pathname.endsWith('/attach'), { timeout: 300_000 }).catch(() => null)
      await page.waitForTimeout(1500)
      console.log(`합류 뒤: ${page.url()}`)
      await shot(page, `2${n}-attach-${n}-joined.png`)
    } else if (cmd === 'shots') {
      const [slug] = args as [string]
      const list: [string, string][] = [
        ['01-home.png', '/'],
        ['02-collections.png', '/collections'],
        ['30-dashboard.png', `/collections/${slug}`],
        ['31-table.png', `/collections/${slug}/table`],
        ['33-feed.png', `/collections/${slug}/feed`],
        ['34-views.png', `/collections/${slug}/views`],
        ['35-sources.png', `/collections/${slug}/sources`],
        ['36-connect.png', `/collections/${slug}/connect`],
        ['37-settings.png', `/collections/${slug}/settings`],
        ['38-workshop.png', `/collections/${slug}/workshop`],
        ['39-gallery.png', '/gallery'],
      ]
      for (const [file, url] of list) {
        await page.goto(`${WEB}${url}`, { waitUntil: 'networkidle' })
        await shot(page, file)
      }
    } else if (cmd === 'saveview') {
      // saveview <slug> <표 주소 쿼리> <뷰 이름> — 표에서 걸러 보고 "이 조건 저장" → 뷰 화면에서 알림 켜기
      const [slug, qs, name] = args as [string, string, string]
      await page.goto(`${WEB}/collections/${slug}/table?${qs}`, { waitUntil: 'networkidle' })
      await shot(page, '32-table-filtered.png')
      await page.locator('#save-view-name').fill(name)
      await page.getByRole('button', { name: '이 조건 저장' }).click()
      await page.waitForURL(/view=/)
      await page.waitForTimeout(800)
      await shot(page, '32-table-view-saved.png')
      await page.goto(`${WEB}/collections/${slug}/views`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '알림 켜기' }).first().click()
      await page.getByRole('button', { name: '알림 끄기' }).first().waitFor()
      console.log(`뷰 저장 · 알림 켬: ${name}`)
    } else if (cmd === 'page') {
      // 임의 화면 하나: page <파일> <경로>
      const [file, url] = args as [string, string]
      await page.goto(`${WEB}${url}`, { waitUntil: 'networkidle' })
      await shot(page, file)
    } else {
      throw new Error(`모르는 명령: ${cmd}`)
    }
  } finally {
    await close()
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('중단:', (e as Error).message)
  process.exit(1)
})
