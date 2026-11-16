// 실제 Postgres 위의 조회 검증 (ADR A46·A50) — 커서 페이지 경계·정렬 안정성·오류 정책.
//
// 실행한 것: 테스트 전용 DB(endpointer_test)의 실제 SQL. 대체한 것: 없음.
// 기준 시각은 고정한다. DB 에 닿지 못하면 이 파일 전체가 "건너뜀" 으로 표시된다 (통과가 아니다).

import { prepareTestDb } from '../testing/test-db'

import { beforeAll, describe, expect, it } from 'vitest'

import { db } from '../db/client'
import { items } from '../db/schema'
import {
  createTestCollection,
  createTestSource,
  createTestUser,
  insertRawView,
  insertTestItems,
  type TestCollection,
} from '../testing/fixtures'
import { MAX_PAGE_LIMIT } from '../types/api'
import type { FieldDef } from '../types/collection'
import { planItemsQuery } from './build'
import { runCollectionRequest } from './resolve'

const status = await prepareTestDb()

const FIELDS: FieldDef[] = [
  { key: 'title', label: '사업명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  { key: 'category', label: '분야', type: 'enum', required: false, mapping: { 'R&D': 'rnd', 창업: 'startup' }, value_labels: null },
  { key: 'link', label: '원문', type: 'link', required: false, mapping: null, value_labels: null },
]

/** 2026-08-10 (월) 12:00 KST */
const NOW = new Date('2026-08-10T03:00:00.000Z')
const TOTAL = 230

/**
 * 230개 — 정렬 기준마다 동률이 많고(같은 금액·같은 마감·같은 제목), 값이 빈 행(null)과
 * 숫자가 아닌 금액이 섞여 있다. 시각을 안 준 200개는 문장 단위로 first_seen_at 이
 * 마이크로초까지 같다(실제 수집과 같은 조건 — 120개·80개 두 덩어리). 뒤 30개는 시각을 따로 준다.
 */
function makeRows() {
  const rows = []
  for (let i = 0; i < TOTAL; i += 1) {
    const amount = i % 9 === 0 ? null : i % 13 === 0 ? '약 1억' : (i % 5) * 10_000_000
    const deadline = i % 7 === 0 ? null : `2026-08-${String(10 + (i % 6)).padStart(2, '0')}`
    rows.push({
      data: {
        title: i % 4 === 0 ? '같은 제목' : `공고 ${String(i).padStart(3, '0')} ${i % 3 === 0 ? '청년' : '일반'}`,
        deadline,
        amount,
        category: i % 2 === 0 ? 'rnd' : 'startup',
        link: `https://a.example/${i}`,
      },
      ...(i >= 200 ? { firstSeenAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i - 200)) } : {}),
    })
  }
  return rows
}

describe.skipIf(!status.ok)('실제 DB — 200개를 넘는 데이터의 커서 페이지 이동', () => {
  let collection: TestCollection

  beforeAll(async () => {
    const owner = await createTestUser()
    collection = await createTestCollection({ ownerId: owner, schema: FIELDS })
    const sA = await createTestSource(collection.id, 'a.example')
    const sB = await createTestSource(collection.id, 'b.example')
    const rows = makeRows()
    // 두 문장으로 넣는다 — 각 문장 안의 행은 같은 now() (120개 · 80개). 마지막 30개만 시각을 따로 준다
    const first = await insertTestItems(collection.id, sA, rows.slice(0, 120))
    const second = await insertTestItems(collection.id, sB, rows.slice(120))
    expect(first.length + second.length).toBe(TOTAL)
  })

  // 응답 항목에는 id 가 없으므로(계약) 링크로 행을 식별한다 — 링크는 행마다 다르다
  async function walkLinks(params: string, pageSize: number) {
    const links: string[] = []
    const offsets: number[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 200; guard += 1) {
      const qs: string = `${params}&limit=${pageSize}${cursor ? `&cursor=${cursor}` : ''}`
      const outcome = await runCollectionRequest(db, collection, { params: qs, now: NOW })
      if (!outcome.ok) throw new Error(`${qs}: ${outcome.message}`)
      offsets.push(outcome.response.page.offset)
      for (const item of outcome.response.items) links.push(String(item._link))
      cursor = outcome.response.page.next_cursor
      if (cursor === null) break
    }
    return { links, offsets }
  }

  /** 같은 정렬식으로 한 번에 읽은 기준 순서 — 페이지를 이어 붙인 결과가 이것과 같아야 한다 */
  async function referenceLinks(params: string): Promise<string[]> {
    const outcome = await runCollectionRequest(db, collection, { params: `${params}&limit=1`, now: NOW })
    if (!outcome.ok) throw new Error(outcome.message)
    const plan = planItemsQuery({ ...outcome.query, cursor: null }, {
      collectionId: collection.id,
      fields: FIELDS,
      sourceIds: outcome.query.source
        ? outcome.sourceRows.filter((s) => s.host === outcome.query.source).map((s) => s.id)
        : null,
    })
    const rows = await db
      .select({ data_json: items.data_json })
      .from(items)
      .where(plan.where)
      .orderBy(...plan.orderBy)
    return rows.map((r) => String((r.data_json as Record<string, unknown>)['link']))
  }

  const SORTS = [
    '', // 기본 = -first_seen_at (앞 200개가 같은 마이크로초)
    'sort=first_seen_at',
    'sort=amount',
    'sort=-amount',
    'sort=deadline',
    'sort=-deadline',
    'sort=title',
    'sort=-title',
    'sort=category',
  ]

  for (const sort of SORTS) {
    it(`누락·중복 없이 끝까지 — ${sort === '' ? '기본 정렬' : sort} (7개씩)`, async () => {
      const { links, offsets } = await walkLinks(sort, 7)
      expect(links).toHaveLength(TOTAL)
      expect(new Set(links).size).toBe(TOTAL)
      expect(links).toEqual(await referenceLinks(sort))
      // offset 은 7씩 늘어난다 — 화면의 "8–14번째" 가 맞다
      expect(offsets).toEqual(offsets.map((_, i) => i * 7))
    })
  }

  it('상한(200)씩 넘겨도 같다 — 200개를 넘는 컬렉션의 두 번째 페이지', async () => {
    const { links, offsets } = await walkLinks('sort=-amount', MAX_PAGE_LIMIT)
    expect(links).toEqual(await referenceLinks('sort=-amount'))
    expect(offsets).toEqual([0, 200])
  })

  it('금액 정렬은 수치 순서 + 빈 값·숫자가 아닌 값은 맨 뒤 (오름·내림 둘 다)', async () => {
    const amountOf = (link: string) => {
      const i = Number(link.split('/').pop())
      return i % 9 === 0 ? null : i % 13 === 0 ? null : (i % 5) * 10_000_000
    }
    for (const [sort, dir] of [['sort=amount', 1], ['sort=-amount', -1]] as const) {
      const { links } = await walkLinks(sort, 13)
      const values = links.map(amountOf)
      const firstNull = values.indexOf(null)
      expect(values.slice(firstNull).every((v) => v === null)).toBe(true)
      const numbers = values.slice(0, firstNull) as number[]
      for (let i = 1; i < numbers.length; i += 1) {
        expect(Math.sign((numbers[i] as number) - (numbers[i - 1] as number)) * dir).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('검색·출처를 건 상태에서도 전체 컬렉션 대상이다 — 앞 200개만 보지 않는다', async () => {
    const outcome = await runCollectionRequest(db, collection, { params: 'q=청년&source=b.example&limit=200', now: NOW })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // b.example 은 121번째 이후 행이다 — 200개 창 밖의 행이 검색에 잡혀야 한다
    const expected = makeRows()
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => i >= 120 && String(r.data.title).includes('청년'))
    expect(outcome.response.page.total).toBe(expected.length)
    expect(outcome.response.items.every((it) => it._source === 'b.example')).toBe(true)
    expect(outcome.response.items.some((it) => Number(String(it._link).split('/').pop()) >= 200)).toBe(true)
  })

  it('정렬을 바꾸고 옛 커서를 보내면 invalid_cursor — 이어 붙이지 않는다', async () => {
    const first = await runCollectionRequest(db, collection, { params: 'sort=amount&limit=10', now: NOW })
    if (!first.ok) throw new Error(first.message)
    const cursor = first.response.page.next_cursor
    const changed = await runCollectionRequest(db, collection, { params: `sort=deadline&limit=10&cursor=${cursor}`, now: NOW })
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.code).toBe('invalid_cursor')
  })

  it('조건을 바꾸고 옛 커서를 보내도 invalid_cursor', async () => {
    const first = await runCollectionRequest(db, collection, { params: 'limit=10', now: NOW })
    if (!first.ok) throw new Error(first.message)
    const changed = await runCollectionRequest(db, collection, {
      params: `category=rnd&limit=10&cursor=${first.response.page.next_cursor}`,
      now: NOW,
    })
    expect(!changed.ok && changed.code).toBe('invalid_cursor')
  })

  it('페이지 크기만 바꾸는 것은 같은 요청이다 — 커서가 그대로 이어진다', async () => {
    const first = await runCollectionRequest(db, collection, { params: 'sort=title&limit=10', now: NOW })
    if (!first.ok) throw new Error(first.message)
    const next = await runCollectionRequest(db, collection, {
      params: `sort=title&limit=25&cursor=${first.response.page.next_cursor}`,
      now: NOW,
    })
    expect(next.ok && next.response.page.offset).toBe(10)
  })

})

describe.skipIf(!status.ok)('실제 DB — 저장된 뷰와 오류 정책', () => {
  let collection: TestCollection
  let owner: string

  beforeAll(async () => {
    owner = await createTestUser()
    collection = await createTestCollection({ ownerId: owner, schema: FIELDS })
    const s = await createTestSource(collection.id, 'a.example')
    await insertTestItems(
      collection.id,
      s,
      Array.from({ length: 40 }, (_, i) => ({
        data: {
          title: `공고 ${i} ${i % 2 === 0 ? '청년' : ''}`,
          amount: i * 5_000_000,
          deadline: `2026-08-${String(5 + (i % 20)).padStart(2, '0')}`,
          category: i % 3 === 0 ? 'rnd' : 'startup',
          link: `https://a.example/${i}`,
        },
      })),
    )
  })

  it('없는 뷰는 view_not_found — 조건 없이 전체를 내지 않는다', async () => {
    const r = await runCollectionRequest(db, collection, { params: '', viewSlug: 'nope', now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('view_not_found')
  })

  it('표 구성이 바뀌어 깨진 뷰는 view_unavailable + 이유', async () => {
    await insertRawView({
      collectionId: collection.id,
      ownerId: owner,
      slug: 'broken',
      name: '깨진 조건',
      where: [{ field: 'budget', op: 'gte', value: 1 }],
    })
    const r = await runCollectionRequest(db, collection, { params: '', viewSlug: 'broken', now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('view_unavailable')
      expect(r.message).toContain('budget')
    }
  })

  it('예전에 저장된 뷰(검색어·출처 칸 없음)는 그대로 동작한다', async () => {
    await insertRawView({
      collectionId: collection.id,
      ownerId: owner,
      slug: 'legacy',
      name: '예전 뷰',
      where: [{ field: 'amount', op: 'gte', value: 100_000_000 }],
      sort: [{ field: 'amount', dir: 'desc' }],
    })
    const r = await runCollectionRequest(db, collection, { params: '', viewSlug: 'legacy', now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const amounts = r.response.items.map((it) => it['amount'] as number)
    expect(amounts.every((a) => a >= 100_000_000)).toBe(true)
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a))
    expect(r.response.page.total).toBe(20) // 20..39 → 1억 이상
  })

  it('뷰 위의 요청 조건은 좁히기만 한다 — 더 넓은 범위를 줘도 뷰가 이긴다', async () => {
    const wider = await runCollectionRequest(db, collection, { params: 'amount_gte=0', viewSlug: 'legacy', now: NOW })
    expect(wider.ok && wider.response.page.total).toBe(20)
    const narrower = await runCollectionRequest(db, collection, {
      params: 'amount_gte=150000000',
      viewSlug: 'legacy',
      now: NOW,
    })
    expect(narrower.ok && narrower.response.page.total).toBe(10)
  })

  it('검색어·출처까지 저장된 뷰', async () => {
    await insertRawView({
      collectionId: collection.id,
      ownerId: owner,
      slug: 'youth',
      name: '청년',
      where: [],
      searchQ: '청년',
      sourceHost: 'a.example',
    })
    const r = await runCollectionRequest(db, collection, { params: '', viewSlug: 'youth', now: NOW })
    expect(r.ok && r.response.page.total).toBe(20)
    // 다른 검색어를 얹으면 거절 (둘 중 하나를 고르지 않는다)
    const conflict = await runCollectionRequest(db, collection, { params: 'q=창업', viewSlug: 'youth', now: NOW })
    expect(!conflict.ok && conflict.code).toBe('invalid_query')
  })

  it('출처가 컬렉션에서 빠진 뷰는 view_unavailable — 조용히 0건이 되지 않는다', async () => {
    await insertRawView({
      collectionId: collection.id,
      ownerId: owner,
      slug: 'gone-source',
      name: '사라진 출처',
      where: [],
      sourceHost: 'gone.example',
    })
    const r = await runCollectionRequest(db, collection, { params: '', viewSlug: 'gone-source', now: NOW })
    expect(!r.ok && r.code).toBe('view_unavailable')
  })

  it('잘못된 조건·상한 초과·깨진 커서는 각각의 코드로 실패한다', async () => {
    const bad = await runCollectionRequest(db, collection, { params: 'categroy=rnd', now: NOW })
    const over = await runCollectionRequest(db, collection, { params: 'limit=201', now: NOW })
    const junk = await runCollectionRequest(db, collection, { params: 'cursor=abc', now: NOW })
    expect(!bad.ok && bad.code).toBe('invalid_query')
    expect(!over.ok && over.code).toBe('limit_exceeded')
    expect(!junk.ok && junk.code).toBe('invalid_cursor')
  })

  it('정렬 결과는 같은 데이터·조건이면 매번 같다 (같은 금액 동률이 흔들리지 않는다)', async () => {
    const a = await runCollectionRequest(db, collection, { params: 'sort=category&limit=40', now: NOW })
    const b = await runCollectionRequest(db, collection, { params: 'sort=category&limit=40', now: NOW })
    if (!a.ok || !b.ok) throw new Error('조회 실패')
    expect(a.response.items.map((i) => i._link)).toEqual(b.response.items.map((i) => i._link))
  })

})
