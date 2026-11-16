// 브라우저 시험 — 둘러보기 · 뷰 이름 바꾸기 · 컬렉션 만들기 화면 (ADR A51)
//
// lint 가 짚은 React 규칙 위반(effect 안 setState · 선언 전 접근)을 고친 세 컴포넌트가
// **고치기 전과 같게 동작하는지** 실제 브라우저로 본다.
//
// ── 실제로 실행한 것 ──────────────────────────────────────────────────────
//  · 빌드한 앱을 테스트 DB 에 붙여 띄우고 Chromium 으로 누른다
// ── 대체한 경계 ────────────────────────────────────────────────────────────
//  · 워커: 컬렉션 만들기의 미리보기는 워커가 사이트를 살펴보고 LLM 으로 표를 만든다. 여기서는 워커 자리에
//    **같은 계약(POST /internal/preview · Bearer 토큰 · 같은 응답 모양)으로 답하는 로컬 서버**를 세운다.
//    화면 쪽 코드(서버 액션 → 워커 호출 → 표 미리보기)는 실제 그대로다.
//  · 로그인: 데모 모드(모두 주인).

import { seedReference, type ReferenceSeed } from '@endpointer/core/testing'

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { queryClient } from '@endpointer/core/db'

import { newContext, prepareE2e, startApp, type RunningApp } from './harness'

const env = await prepareE2e()
const ready = env.ready

const WORKER_TOKEN = 'e2e-worker-token'
/** 워커 대역이 받은 미리보기 요청 */
const previewCalls: { url: string; auth: string | undefined }[] = []
/** 미리보기 응답 지연 — 단계 연출(2.5초 간격)이 한 칸 넘어갈 만큼 */
const PREVIEW_DELAY_MS = 3_200

let worker: Server | null = null
let app: RunningApp | null = null

beforeAll(async () => {
  if (!ready) return
  worker = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url !== '/internal/preview' || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as { url: string }
      previewCalls.push({ url: body.url, auth: req.headers.authorization })
      const n = previewCalls.length
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            host: 'stub.example',
            entry_url: body.url,
            suggested_name: n === 1 ? '첫 미리보기' : '두번째 미리보기',
            fields: [
              { key: 'title', label: '공고명', type: 'text', required: true, mapping: null, value_labels: null },
              { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
            ],
            rows: [{ title: `미리보기 ${n}`, amount: 1000 * n }],
            trace: {},
          }),
        )
      }, PREVIEW_DELAY_MS)
    })
  })
  await new Promise<void>((r) => (worker as Server).listen(0, '127.0.0.1', () => r()))
  const workerUrl = `http://127.0.0.1:${((worker as Server).address() as AddressInfo).port}`
  app = await startApp({ WORKER_INTERNAL_URL: workerUrl, WORKER_INTERNAL_TOKEN: WORKER_TOKEN })
})

afterAll(async () => {
  await env.browser?.close()
  app?.stop()
  await new Promise<void>((r) => (worker ? worker.close(() => r()) : r()))
})

describe.skipIf(!ready)('둘러보기 — 처음 오면 뜨고, 건너뛰면 다시 안 뜬다', () => {
  let context: BrowserContext
  let page: Page
  let ref: ReferenceSeed

  beforeAll(async () => {
    ref = await seedReference()
    context = await newContext(env.browser!, { tourSeen: false })
    page = await context.newPage()
  })

  afterAll(async () => {
    await context?.close()
  })

  it('처음 방문 — 둘러보기가 뜬다 (화면이 그려진 뒤 다음 프레임에 시작)', async () => {
    await page.goto(`${app!.base}/collections/${ref.collection.slug}/table`)
    await expect.poll(async () => page.getByRole('button', { name: '건너뛰기' }).isVisible(), { timeout: 5_000 }).toBe(true)
  })

  it('건너뛰면 닫히고, 새로고침해도 다시 안 뜬다', async () => {
    await page.getByRole('button', { name: '건너뛰기' }).click()
    await expect.poll(async () => page.getByRole('button', { name: '건너뛰기' }).count()).toBe(0)
    await page.reload()
    await page.waitForTimeout(1_000) // 다음 프레임에 뜨는 것이라 잠깐 기다려 본다
    expect(await page.getByRole('button', { name: '건너뛰기' }).count()).toBe(0)
  })
})

describe.skipIf(!ready)('뷰 이름 바꾸기 — 저장하면 편집 칸이 닫히고 주소(slug)는 그대로', () => {
  it('연필 → 새 이름 → 저장', async () => {
    const ref = await seedReference()
    const context = await newContext(env.browser!, { tourSeen: true })
    const page = await context.newPage()
    await page.goto(`${app!.base}/collections/${ref.collection.slug}/views`)

    await page.getByRole('button', { name: '이름 바꾸기' }).first().click()
    const input = page.getByRole('textbox', { name: '조건 이름' })
    await input.fill('E2E 새 이름')
    await page.getByRole('button', { name: '저장', exact: true }).click()

    // 편집 칸이 닫히고 새 이름이 링크로 보인다
    await expect.poll(async () => input.count()).toBe(0)
    expect(await page.getByRole('link', { name: 'E2E 새 이름' }).count()).toBe(1)

    const rows = await queryClient<{ name: string; slug: string }[]>`
      select name, slug from views where collection_id = ${ref.collection.id}
    `
    expect(rows).toEqual([{ name: 'E2E 새 이름', slug: ref.viewSlug }])
    await context.close()
  })
})

describe.skipIf(!ready)('컬렉션 만들기 — 미리보기를 다시 받으면 단계 연출과 편집 상태가 처음으로', () => {
  /** 단계 표시 하나의 상태 — 스피너(진행 중) · ✓(끝) · 번호(아직) */
  async function stepState(page: Page, label: string): Promise<'active' | 'done' | 'todo'> {
    const marker = page.locator('span', { hasText: label }).locator('xpath=preceding-sibling::span[1]')
    const cls = (await marker.getAttribute('class')) ?? ''
    if (cls.includes('animate-spin')) return 'active'
    if ((await marker.innerText()).includes('✓')) return 'done'
    return 'todo'
  }

  it('두 번 미리보기를 받는다', async () => {
    const context = await newContext(env.browser!, { tourSeen: true })
    const page = await context.newPage()
    await page.goto(`${app!.base}/collections/new`)

    await page.locator('#create-url').fill('https://stub.example/list')
    await page.getByRole('button', { name: '담기', exact: true }).click()

    // ── 1회차 — 단계 연출이 첫 단계부터 돌고, 응답이 오면 이름이 채워진다 ──
    await page.getByRole('button', { name: '컬렉션 만들기 →' }).click()
    await expect.poll(async () => stepState(page, '페이지를 열어봤어요')).toBe('active')
    await expect.poll(async () => stepState(page, '목록 구조를 찾았어요'), { timeout: 5_000 }).toBe('active')
    await expect.poll(async () => page.locator('#create-name').inputValue(), { timeout: 8_000 }).toBe('첫 미리보기')
    expect(previewCalls[0]).toEqual({ url: 'https://stub.example/list', auth: `Bearer ${WORKER_TOKEN}` })

    // 미리보기를 편집한다 — 열 하나를 지우고 이름을 고친다
    await page.getByRole('button', { name: '공고명 열 지우기' }).click()
    expect(await page.getByRole('button', { name: '공고명 열 지우기' }).count()).toBe(0)
    await page.locator('#create-name').fill('내가 고친 이름')

    // ── 2회차 — 누르는 순간 첫 단계로 돌아가고(예전 effect 가 하던 일), 응답이 오면 편집이 새 미리보기에 맞춰진다 ──
    await page.getByRole('button', { name: '컬렉션 만들기 →' }).click()
    await expect.poll(async () => stepState(page, '페이지를 열어봤어요')).toBe('active')
    expect(await stepState(page, '목록 구조를 찾았어요')).toBe('todo')
    await expect.poll(async () => page.locator('#create-name').inputValue(), { timeout: 8_000 }).toBe('두번째 미리보기')
    // 지웠던 열이 새 미리보기에서 다시 보인다
    expect(await page.getByRole('button', { name: '공고명 열 지우기' }).count()).toBe(1)
    expect(previewCalls).toHaveLength(2)
    await context.close()
  })
})
