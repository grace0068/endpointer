// 브라우저 시험 — 표의 클라이언트 동작과 뷰 저장 흐름 (ADR A46·A47·A51)
//
// ── 실제로 실행한 것 ──────────────────────────────────────────────────────
//  · 빌드한 웹 앱(`next start`)을 **테스트 DB(endpointer_test)** 에 붙여 임의 포트로 띄운다
//  · Playwright Chromium(헤드리스)으로 실제로 누른다 — 열 끌기(HTML5 드래그), 열 고르기,
//    정렬 머리글, 다음 페이지·뒤로 가기, 전체 검색, 새 뷰 저장, 뷰 덮어쓰기
//  · 결과는 화면 글자 · 주소 · DB 세 군데에서 확인한다
// ── 대체한 경계 ────────────────────────────────────────────────────────────
//  · 첫 방문 둘러보기(투어): 이미 본 사람으로 시작한다(브라우저 저장소). 둘러보기 자체는 flows.e2e.ts 가 본다.
//  · 로그인: Google 자격증명이 없어 데모 모드(로그인 전 = 모두 주인)로 돈다. 그래서 "멤버는 저장 못 함" 은
//    여기서 못 본다 — 같은 판정 함수를 test/views.db.test.ts 가 행위자를 직접 넣어 본다.
// 빌드가 없거나 DB·브라우저가 없으면 건너뜀으로 표시한다 (통과로 세지 않는다 — A50).

import { seedReference, type ReferenceSeed } from '@endpointer/core/testing'

import type { BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { queryClient } from '@endpointer/core/db'

import { headers, newContext, prepareE2e, range, startApp, type RunningApp } from './harness'

const env = await prepareE2e()
const ready = env.ready

let app: RunningApp | null = null
let base = ''
let context: BrowserContext | null = null

beforeAll(async () => {
  if (!ready || env.browser === null) return
  app = await startApp()
  base = app.base
  // 둘러보기는 이미 본 사람으로 — 둘러보기 자체는 flows.e2e.ts 가 시험한다
  context = await newContext(env.browser, { tourSeen: true })
})

afterAll(async () => {
  await context?.close()
  await env.browser?.close()
  app?.stop()
})

async function newPage(): Promise<Page> {
  return (context as BrowserContext).newPage()
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url)
}

describe.skipIf(!ready)('브라우저 — 표의 열·정렬·페이지·검색', () => {
  let ref: ReferenceSeed
  let page: Page
  let tablePath: string

  beforeAll(async () => {
    ref = await seedReference()
    tablePath = `${base}/collections/${ref.collection.slug}/table`
    page = await newPage()
  })

  afterAll(async () => {
    await page?.close()
  })

  it('처음 열면 서버가 전체에서 한 페이지(50개)를 그린다', async () => {
    await open(page, tablePath)
    expect(await range(page)).toBe('전체 240개 중 1–50번째 · 뒤에 더 있어요')
    expect(await page.locator('tbody tr').count()).toBe(50)
    expect(await headers(page)).toEqual(['출처', '공고명', '마감일', '지원금', '분야', '원문'])
  })

  it('열을 끌어 옮기면 주소(cols)에 남고, 새로고침해도 그 순서다', async () => {
    await page.locator('thead th', { hasText: '지원금' }).dragTo(page.locator('thead th', { hasText: '공고명' }))
    await page.waitForURL(/cols=/)
    expect(new URL(page.url()).searchParams.get('cols')).toBe('_source,amount,title,deadline,category,link')
    await page.reload()
    expect(await headers(page)).toEqual(['출처', '지원금', '공고명', '마감일', '분야', '원문'])
  })

  it('열 고르기로 끄면 사라지고, 열 초기화로 돌아온다', async () => {
    await page.locator('summary', { hasText: '열 고르기' }).click()
    await page.getByRole('checkbox', { name: '분야' }).uncheck()
    await page.waitForURL((u) => !(u.searchParams.get('cols') ?? '').includes('category'))
    expect(await headers(page)).not.toContain('분야')

    await page.getByRole('button', { name: '열 초기화' }).click()
    await page.waitForURL((u) => !u.searchParams.has('cols'))
    expect(await headers(page)).toEqual(['출처', '공고명', '마감일', '지원금', '분야', '원문'])
  })

  it('머리글을 누르면 서버가 전체를 다시 정렬한다 — 다음 페이지 · 뒤로 가기로 상태가 돌아온다', async () => {
    await page.locator('thead th a', { hasText: '지원금' }).click()
    await page.waitForURL(/sort=amount/)
    // 금액은 (i+1)*1000 — 오름차순 첫 행은 1,000원 (전체 240개 중 가장 작은 값)
    await expect.poll(async () => page.locator('tbody tr').first().innerText()).toContain('1,000원')

    await page.getByRole('link', { name: /다음 50개/ }).click()
    await page.waitForURL(/cursor=/)
    expect(await range(page)).toBe('전체 240개 중 51–100번째 · 뒤에 더 있어요')
    expect(await page.locator('tbody tr').first().innerText()).toContain('51,000원')

    await page.goBack()
    await page.waitForURL((u) => !u.searchParams.has('cursor'))
    // 주소가 먼저 바뀌고 화면은 서버가 다시 그린 뒤에 바뀐다 — 그때까지 기다린다
    await expect.poll(async () => range(page)).toBe('전체 240개 중 1–50번째 · 뒤에 더 있어요')
  })

  it('전체 검색은 전체 컬렉션 대상 — 200번째 너머의 행까지 찾는다', async () => {
    await open(page, tablePath)
    await page.getByRole('searchbox').fill('공고 23')
    await page.getByRole('button', { name: '걸러보기' }).click()
    await page.waitForURL(/q=/)
    expect(await range(page)).toBe('전체 10개 중 1–10번째')
  })
})

describe.skipIf(!ready)('브라우저 — 지금 상태를 뷰로 저장하고, 고쳐서 덮어쓴다', () => {
  let ref: ReferenceSeed
  let page: Page
  let tablePath: string

  beforeAll(async () => {
    ref = await seedReference()
    tablePath = `${base}/collections/${ref.collection.slug}/table`
    page = await newPage()
  })

  afterAll(async () => {
    await page?.close()
  })

  async function storedView(slug: string) {
    const rows = await queryClient<{ name: string; search_q: string | null; sort_json: unknown; columns_json: unknown }[]>`
      select name, search_q, sort_json, columns_json from views where collection_id = ${ref.collection.id} and slug = ${slug}
    `
    return rows[0] ?? null
  }

  it('검색어·정렬·열까지 담아 새 뷰로 저장 → 그 뷰 주소로 이동하고 칩이 생긴다', async () => {
    await open(page, `${tablePath}?q=${encodeURIComponent('청년')}&sort=-amount&cols=title,amount,_source`)
    const name = page.locator('#save-view-name')
    await name.fill('E2E Youth')
    await page.getByRole('button', { name: '이 조건 저장' }).click()
    await page.waitForURL(/view=e2e-youth/)

    expect(await page.getByRole('link', { name: 'E2E Youth' }).count()).toBeGreaterThan(0)
    expect(await storedView('e2e-youth')).toEqual({
      name: 'E2E Youth',
      search_q: '청년',
      sort_json: [{ field: 'amount', dir: 'desc' }],
      columns_json: ['title', 'amount', '_source'],
    })
    // 저장된 표시 설정이 되살아난다
    expect(await headers(page)).toEqual(['공고명', '지원금', '출처'])
    expect(await range(page)).toBe('전체 60개 중 1–50번째 · 뒤에 더 있어요')
  })

  it('뷰에서 정렬을 바꾸면 "고치는 중" 이 되고, 덮어쓰면 주소(slug)는 그대로 조건만 바뀐다', async () => {
    // 지금 금액 내림차순 → 머리글을 누르면 정렬 해제(기본: 새로 올라온 순). 조회 상태가 바뀐다
    await page.locator('thead th a', { hasText: '지원금' }).click()
    await page.waitForURL(/base=e2e-youth/)
    await page.getByRole('button', { name: /E2E Youth.*덮어쓰기/ }).click()
    await page.waitForURL(/view=e2e-youth/)

    const after = await storedView('e2e-youth')
    expect(after?.search_q).toBe('청년')
    expect(after?.sort_json).toEqual([])
    const count = await queryClient<{ n: number }[]>`select count(*)::int n from views where collection_id = ${ref.collection.id}`
    expect(count[0]?.n).toBe(2) // 기준 데이터의 뷰 1 + 이번 뷰 1 — 새로 생기지 않았다
  })
})
