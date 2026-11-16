// 뷰 기준선 (ADR A52) — 실제 Postgres 위에서.
//
// 실행한 것: 테스트 전용 DB(endpointer_test)의 실제 SQL. 대체한 것: 없음.
// DB 에 닿지 못하면 이 파일 전체가 "건너뜀" 으로 표시된다 (통과가 아니다).

import { prepareTestDb } from '../testing/test-db'

import { beforeAll, describe, expect, it } from 'vitest'

import { db, queryClient } from '../db/client'
import {
  createTestCollection,
  createTestSource,
  createTestUser,
  insertRawView,
  insertTestItems,
  type TestCollection,
} from '../testing/fixtures'
import type { FieldDef } from '../types/collection'
import { baselineViewMatches, baselineViewMatchesBySlug, currentViewMatchIds } from './matches'
import { loadSourceStates } from './respond'
import type { StoredViewRow } from './resolve'

const status = await prepareTestDb()

const FIELDS: FieldDef[] = [
  { key: 'title', label: '사업명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
]

async function matchedIds(viewId: string): Promise<string[]> {
  const rows = await queryClient<{ item_id: string }[]>`select item_id from view_matches where view_id = ${viewId}`
  return rows.map((r) => r.item_id).sort()
}

async function notificationCount(itemIds: readonly string[]): Promise<number> {
  if (itemIds.length === 0) return 0
  const rows = await queryClient<{ n: number }[]>`
    select count(*)::int n from notification_log where item_id = any(string_to_array(${itemIds.join(',')}, ',')::uuid[])`
  return rows[0]?.n ?? 0
}

describe.skipIf(!status.ok)('뷰 기준선 — 정의가 정해지는 순간의 매칭 집합 (A52)', () => {
  let c: TestCollection
  let sourceId: string
  let youth: string[]
  let other: string[]

  beforeAll(async () => {
    const owner = await createTestUser('기준선')
    c = await createTestCollection({ ownerId: owner, schema: FIELDS })
    sourceId = await createTestSource(c.id, 'baseline.example')
    youth = await insertTestItems(c.id, sourceId, [
      { data: { title: '청년 창업', amount: 1000 } },
      { data: { title: '청년 연구', amount: 9000 } },
    ])
    other = await insertTestItems(c.id, sourceId, [{ data: { title: '중장년 재취업', amount: 5000 } }])
  })

  it('만들 때 — 지금 맞는 항목이 기록되고, 알림 기록은 생기지 않는다', async () => {
    const viewId = await insertRawView({ collectionId: c.id, ownerId: c.owner_id, slug: 'youth', name: '청년', where: [], searchQ: '청년' })
    expect(await matchedIds(viewId)).toEqual([])

    const r = await baselineViewMatchesBySlug(db, c.id, 'youth')
    expect(r).toEqual({ ok: true, matched: 2 })
    expect(await matchedIds(viewId)).toEqual([...youth].sort())
    expect(await notificationCount(youth)).toBe(0)
  })

  it('조건을 바꿔 다시 잡으면 — 빠진 것은 지워지고, 새로 맞는 것이 들어간다', async () => {
    const viewId = await insertRawView({
      collectionId: c.id, ownerId: c.owner_id, slug: 'big', name: '큰 금액',
      where: [{ field: 'amount', op: 'gte', value: 9000 }],
    })
    await baselineViewMatches(db, c.id, viewId)
    expect(await matchedIds(viewId)).toEqual([youth[1]])

    await queryClient`update views set where_json = ${JSON.stringify([{ field: 'amount', op: 'gte', value: 5000 }])}::jsonb where id = ${viewId}`
    await baselineViewMatches(db, c.id, viewId)
    expect(await matchedIds(viewId)).toEqual([youth[1], other[0]].sort())
  })

  it('기준선 뒤 평가와 같은 집합이다 — 그래서 다음 평가의 차집합은 비어 있다', async () => {
    const rows = await queryClient<StoredViewRow[]>`
      select id, slug, name, where_json, sort_json, search_q, source_host, columns_json, notify_json, pinned, created_at
      from views where collection_id = ${c.id} and slug = 'youth'`
    const view = rows[0] as StoredViewRow
    const current = await currentViewMatchIds(db, c.id, view, FIELDS, await loadSourceStates(db, c.id), new Date())
    expect([...(current ?? [])].sort()).toEqual(await matchedIds(view.id))
  })

  it('깨진 뷰(사라진 칸)는 기준선을 잡지 않는다 · 다른 컬렉션의 뷰 id 는 못 건드린다', async () => {
    const broken = await insertRawView({
      collectionId: c.id, ownerId: c.owner_id, slug: 'broken', name: '깨짐',
      where: [{ field: 'budget', op: 'gte', value: 1 }],
    })
    expect(await baselineViewMatches(db, c.id, broken)).toEqual({ ok: false, reason: 'broken' })
    expect(await matchedIds(broken)).toEqual([])

    const otherOwner = await createTestUser('남')
    const otherCol = await createTestCollection({ ownerId: otherOwner, schema: FIELDS })
    const youthView = (await queryClient<{ id: string }[]>`select id from views where collection_id = ${c.id} and slug = 'youth'`)[0]!.id
    expect(await baselineViewMatches(db, otherCol.id, youthView)).toEqual({ ok: false, reason: 'not_found' })
  })
})
