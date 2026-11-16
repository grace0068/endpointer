// 웹 표 · REST 의 결과가 기준 데이터의 기대값과 같은가 (ADR A46·A50)
//
// 실행한 것: 테스트 DB(endpointer_test)의 실제 SQL · REST 라우트 핸들러(GET) 직접 호출 · 웹 표의 서버 조회 함수.
// 대체한 것: Next HTTP 서버는 띄우지 않는다(핸들러를 직접 부른다). REST 는 기준 시각을 주입할 길이 없어
// Date 만 가짜 시계로 고정한다(타이머는 그대로).
// MCP 는 apps/mcp 의 mcp.db.test.ts 가 **같은 기대값**(core/testing reference)과 비교한다 — 그래서 셋이 같다.

import { prepareTestDb, REFERENCE_NOW, seedReference, type ReferenceSeed } from '@endpointer/core/testing'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/v1/[collection]/route'
import type { PublicApiBody } from '@/lib/public-api'
import { loadTablePage, TABLE_PAGE_SIZE } from '@/lib/table-data'
import { parseTableParams } from '@/lib/table-state'

const status = await prepareTestDb()

async function rest(slug: string, qs: string, headers: Record<string, string> = {}) {
  const res = await GET(new Request(`http://test.local/api/v1/${slug}?${qs}`, { headers }), {
    params: Promise.resolve({ collection: slug }),
  })
  return { status: res.status, body: (await res.json()) as PublicApiBody }
}

/** REST 를 커서 끝까지 따라가 링크를 모은다 */
async function restWalk(slug: string, qs: string, limit: number): Promise<string[]> {
  const links: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 100; guard += 1) {
    const { status: code, body } = await rest(slug, `${qs}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
    expect(code).toBe(200)
    for (const item of body.items) links.push(String(item._link))
    cursor = body.page.next_cursor
    if (cursor === null) break
  }
  return links
}

describe.skipIf(!status.ok)('표면 일치 — 웹 표 · REST (기준 데이터 240개 · 기준 시각 고정)', () => {
  let ref: ReferenceSeed

  beforeAll(async () => {
    ref = await seedReference()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('웹 표: 저장된 뷰(상대 날짜 D-7·검색어·분야·금액순)가 기대값과 같다', async () => {
    const load = await loadTablePage(ref.collection, { viewSlug: ref.viewSlug, cursor: null, now: REFERENCE_NOW })
    expect(load.ok).toBe(true)
    if (!load.ok) return
    expect(load.response.items.map((i) => i._link)).toEqual(ref.expectedView)
    expect(load.response.page.total).toBe(ref.expectedView.length)
  })

  it('웹 표: 임시 조건(출처·금액순)을 페이지로 끝까지 넘기면 기대값과 같다 — 200개 경계 너머까지', async () => {
    const parsed = parseTableParams({ source: ref.hostB, sort: '-amount' }, ref.collection.schema_json)
    if (!parsed.ok) throw new Error(parsed.problems.join())
    const links: string[] = []
    let cursor: string | null = null
    let pages = 0
    for (let guard = 0; guard < 20; guard += 1) {
      const load = await loadTablePage(ref.collection, { state: parsed.state, cursor, now: REFERENCE_NOW })
      if (!load.ok) throw new Error(load.message)
      links.push(...load.response.items.map((i) => i._link as string))
      pages += 1
      cursor = load.response.page.next_cursor
      if (cursor === null) break
    }
    expect(pages).toBe(Math.ceil(ref.expectedAdhoc.length / TABLE_PAGE_SIZE))
    expect(links).toEqual(ref.expectedAdhoc)
  })

  it('웹 표: 검색은 전체 컬렉션 대상 — 200번째 이후 행도 잡힌다', async () => {
    const parsed = parseTableParams({ q: '공고 23' }, ref.collection.schema_json)
    if (!parsed.ok) throw new Error(parsed.problems.join())
    const load = await loadTablePage(ref.collection, { state: parsed.state, cursor: null, now: REFERENCE_NOW })
    if (!load.ok) throw new Error(load.message)
    // '공고 23x' — 230~239 (전부 200번째 너머)
    expect(load.response.items.map((i) => i._link).sort()).toEqual(
      ref.rows.filter((r) => r.title.includes('공고 23')).map((r) => r.link).sort(),
    )
  })

  it('REST: 같은 저장된 뷰(?view=)가 같은 기대값', async () => {
    vi.useFakeTimers({ now: REFERENCE_NOW, toFake: ['Date'] })
    const { status: code, body } = await rest(ref.collection.slug, `view=${ref.viewSlug}`)
    expect(code).toBe(200)
    expect(body.items.map((i) => i._link)).toEqual(ref.expectedView)
  })

  it('REST: 같은 임시 조건을 7개씩 넘겨도 같은 기대값 (누락·중복 없음)', async () => {
    expect(await restWalk(ref.collection.slug, ref.adhocQuery, 7)).toEqual(ref.expectedAdhoc)
  })

  it('REST: 뷰 위에 요청 조건은 좁히기만 — 다른 검색어를 얹으면 400 invalid_query', async () => {
    vi.useFakeTimers({ now: REFERENCE_NOW, toFake: ['Date'] })
    const { status: code, body } = await rest(ref.collection.slug, `view=${ref.viewSlug}&q=창업`)
    expect(code).toBe(400)
    expect(body.error?.code).toBe('invalid_query')
    expect(body.items).toEqual([]) // 실패해도 모양은 같다
  })
})
