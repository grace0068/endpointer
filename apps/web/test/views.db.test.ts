// 뷰 저장 · 수정 · 복원 · 호환 · 권한 (ADR A47·A50) — 실제 DB · REST 핸들러 직접 호출.
//
// 실행한 것: 테스트 DB 의 실제 SQL, lib/views(저장·수정·삭제), 웹 표 조회, REST GET.
// 대체한 것: 로그인 — 행위자를 직접 준다 (서버 액션은 currentActor() 로 같은 함수를 부른다).

import {
  REFERENCE_NOW,
  addTestMember,
  createTestUser,
  insertRawView,
  prepareTestDb,
  seedReference,
  type ReferenceSeed,
} from '@endpointer/core/testing'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/v1/[collection]/route'
import type { PublicApiBody } from '@/lib/public-api'
import { loadCore } from '@/lib/db'
import type { Actor } from '@/lib/permissions'
import { loadTablePage } from '@/lib/table-data'
import type { TableState } from '@/lib/table-state'
import { createView, deleteView, getViewBySlug, listViews, renameView, setViewNotify, updateView } from '@/lib/views'

const status = await prepareTestDb()

async function rest(slug: string, qs: string) {
  const res = await GET(new Request(`http://test.local/api/v1/${slug}?${qs}`), { params: Promise.resolve({ collection: slug }) })
  return { status: res.status, body: (await res.json()) as PublicApiBody }
}

describe.skipIf(!status.ok)('뷰 — 지금 보는 상태를 그대로 저장하고 그대로 되살린다', () => {
  let ref: ReferenceSeed
  let ownerActor: Actor
  let memberActor: Actor
  let outsiderActor: Actor

  beforeAll(async () => {
    ref = await seedReference()
    ownerActor = { userId: ref.ownerId, authReady: true }
    const member = await createTestUser('멤버')
    await addTestMember(ref.collection.id, member)
    memberActor = { userId: member, authReady: true }
    outsiderActor = { userId: await createTestUser('외부인'), authReady: true }
  })

  afterEach(() => vi.useRealTimers())

  const FULL_STATE: () => TableState = () => ({
    where: [
      { field: 'deadline', op: 'd_within', value: 7 }, // 상대 날짜
      { field: 'category', op: 'not_in', value: ['startup'] }, // 필터 바에 칸이 없는 조건
    ],
    q: '청년',
    source: null,
    sort: [{ field: 'amount', dir: 'desc' }],
    columns: ['title', '_source', 'amount'],
  })

  it('검색어·정렬·열·상대 날짜까지 저장되고, 읽으면 그대로다 (상대 날짜는 절대 날짜로 바뀌지 않는다)', async () => {
    const saved = await createView(ref.collection, ownerActor, { name: 'My Youth', state: FULL_STATE() })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.slug).toBe('my-youth')

    const back = await getViewBySlug(ref.collection, saved.slug)
    expect(back.ok && back.data).toMatchObject({
      name: 'My Youth',
      state: { where: FULL_STATE().where, q: '청년', source: null, sort: FULL_STATE().sort },
      columns: ['title', '_source', 'amount'],
      health: 'ok',
    })
    // DB 에 저장된 원본 — 'd_within 7' 이지 '2026-08-17' 이 아니다
    const core = await loadCore()
    const rows = await core!.queryClient<{ where_json: unknown }[]>`select where_json from views where collection_id = ${ref.collection.id} and slug = ${saved.slug}`
    expect(JSON.stringify(rows[0]?.where_json)).toContain('"d_within"')
    expect(JSON.stringify(rows[0]?.where_json)).not.toContain('2026-08')
  })

  it('저장한 뷰는 웹 표와 REST 에서 같은 결과 (조회 상태는 같은 뜻)', async () => {
    const page = await loadTablePage(ref.collection, { viewSlug: 'my-youth', cursor: null, now: REFERENCE_NOW })
    vi.useFakeTimers({ now: REFERENCE_NOW, toFake: ['Date'] })
    const r = await rest(ref.collection.slug, 'view=my-youth')
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(r.status).toBe(200)
    expect(r.body.items.map((i) => i._link)).toEqual(page.response.items.map((i) => i._link))
    // 기대값으로도 — R&D 만 남기는 not_in 은 기준 뷰(in rnd)와 같은 집합이다
    expect(page.response.items.map((i) => i._link)).toEqual(ref.expectedView)
  })

  it('수정해도 slug(REST ?view=, AI 도구 이름)는 그대로 — 조건만 바뀐다', async () => {
    const before = await rest(ref.collection.slug, 'view=my-youth&limit=1')
    const updated = await updateView(ref.collection, ownerActor, 'my-youth', {
      state: { ...FULL_STATE(), where: [], q: null, sort: [{ field: 'amount', dir: 'asc' }] },
    })
    expect(updated).toEqual({ ok: true, slug: 'my-youth' })
    const after = await rest(ref.collection.slug, 'view=my-youth&limit=1')
    expect(after.status).toBe(200)
    expect(after.body.page.total).toBe(240)
    expect(after.body.page.total).not.toBe(before.body.page.total)
    expect(after.body.items[0]?._link).toBe('https://ref.example/0') // 금액 오름차순 첫 행
    const back = await getViewBySlug(ref.collection, 'my-youth')
    expect(back.ok && back.data?.name).toBe('My Youth') // 이름을 안 주면 이름은 그대로
  })

  it('예전에 저장된 뷰(검색어·출처 칸이 없던 때, 열에 사라진 칸)도 그대로 읽히고 적용된다', async () => {
    await insertRawView({
      collectionId: ref.collection.id,
      ownerId: ref.ownerId,
      slug: 'legacy',
      name: '예전',
      where: [{ field: 'amount', op: 'gte', value: 200_000 }],
      sort: [{ field: 'amount', dir: 'desc' }],
      columns: ['title', 'gone_column'],
    })
    const listed = await listViews(ref.collection)
    const legacy = listed.ok ? listed.data.find((v) => v.slug === 'legacy') : undefined
    expect(legacy).toMatchObject({ health: 'ok', state: { q: null, source: null }, columns: ['title'], droppedColumns: ['gone_column'] })
    const r = await rest(ref.collection.slug, 'view=legacy')
    expect(r.status).toBe(200)
    expect(r.body.page.total).toBe(41) // 200_000 ~ 240_000
  })

  it('주인이 아니면 만들기·고치기·지우기·이름·알림 전부 거절 — DB 는 그대로', async () => {
    const listed = await listViews(ref.collection)
    const target = listed.ok ? listed.data.find((v) => v.slug === 'my-youth') : undefined
    if (target === undefined) throw new Error('뷰가 없다')
    for (const actor of [memberActor, outsiderActor, { userId: null, authReady: true }]) {
      expect((await createView(ref.collection, actor, { name: 'x', state: FULL_STATE() })).ok).toBe(false)
      expect((await updateView(ref.collection, actor, 'my-youth', { state: FULL_STATE() })).ok).toBe(false)
      expect((await deleteView(ref.collection, actor, target.id)).ok).toBe(false)
      expect((await renameView(ref.collection, actor, target.id, 'x')).ok).toBe(false)
      expect((await setViewNotify(ref.collection, actor, target.id, true)).ok).toBe(false)
    }
    const after = await getViewBySlug(ref.collection, 'my-youth')
    expect(after.ok && after.data?.name).toBe('My Youth')
    expect(after.ok && after.data?.notify).toBeNull()
  })

  it('다른 컬렉션의 뷰는 이 컬렉션 주소로 못 고친다 (소속 확인)', async () => {
    const other = await seedReference()
    const otherViews = await listViews(other.collection)
    const otherView = otherViews.ok ? otherViews.data[0] : undefined
    if (otherView === undefined) throw new Error('다른 뷰가 없다')
    // 이 컬렉션의 주인으로, 다른 컬렉션의 뷰 id 를 넣는다
    expect((await deleteView(ref.collection, ownerActor, otherView.id)).ok).toBe(false)
    const still = await getViewBySlug(other.collection, otherView.slug)
    expect(still.ok && still.data).not.toBeNull()
  })

  it('없는 출처·없는 칸으로는 저장하지 않는다', async () => {
    expect((await createView(ref.collection, ownerActor, { name: 'bad1', state: { ...FULL_STATE(), source: 'nope.example' } })).ok).toBe(false)
    expect(
      (await createView(ref.collection, ownerActor, { name: 'bad2', state: { ...FULL_STATE(), where: [{ field: 'ghost', op: 'gte', value: 1 }] } })).ok,
    ).toBe(false)
  })

  it('표 구성이 바뀌어 쓸 수 없게 된 뷰: 표·REST 모두 원인을 말하고 더 넓은 결과를 내지 않는다', async () => {
    await insertRawView({
      collectionId: ref.collection.id,
      ownerId: ref.ownerId,
      slug: 'needs-fix',
      name: '고칠 것',
      where: [{ field: 'budget', op: 'gte', value: 1 }, { field: 'category', op: 'in', value: ['rnd'] }],
    })
    const page = await loadTablePage(ref.collection, { viewSlug: 'needs-fix', cursor: null })
    expect(page.ok).toBe(false)
    if (!page.ok) expect(page.problems.join(' ')).toContain('budget')
    const r = await rest(ref.collection.slug, 'view=needs-fix')
    expect(r.status).toBe(422)
    expect(r.body.error?.code).toBe('view_unavailable')
    // 고치는 길: 맞지 않는 조건을 빼고 덮어쓰면 다시 쓸 수 있다 (slug 그대로)
    const fixed = await updateView(ref.collection, ownerActor, 'needs-fix', {
      state: { where: [{ field: 'category', op: 'in', value: ['rnd'] }], q: null, source: null, sort: [], columns: null },
    })
    expect(fixed.ok).toBe(true)
    expect((await rest(ref.collection.slug, 'view=needs-fix')).status).toBe(200)
  })

  it('저장·덮어쓰기·알림 켬 순간 지금 맞는 항목이 기준선이 된다 — 그 뒤에 들어온 것만 알린다 (A52)', async () => {
    const core = await loadCore()
    const sql = core!.queryClient
    const matched = async (slug: string) =>
      (await sql<{ n: number }[]>`
        select count(*)::int n from view_matches m join views v on v.id = m.view_id
        where v.collection_id = ${ref.collection.id} and v.slug = ${slug}`)[0]?.n
    const state: TableState = { where: [], q: '청년', source: null, sort: [], columns: null }

    const saved = await createView(ref.collection, ownerActor, { name: 'Baseline', state })
    expect(saved.ok).toBe(true)
    const total = (await rest(ref.collection.slug, 'view=baseline&limit=1')).body.page.total
    expect(total).toBeGreaterThan(0)
    expect(await matched('baseline')).toBe(total) // 저장 순간 이미 맞는 것 = 기준선

    // 기록을 비워 두고 알림을 켜면 — 켜는 순간 다시 잡는다
    const view = (await sql<{ id: string }[]>`select id from views where collection_id = ${ref.collection.id} and slug = 'baseline'`)[0]!
    await sql`delete from view_matches where view_id = ${view.id}`
    expect((await setViewNotify(ref.collection, ownerActor, view.id, true)).ok).toBe(true)
    expect(await matched('baseline')).toBe(total)

    // 조건을 바꿔 덮어쓰면 새 조건의 집합이 기준선이다 (검색어를 빼면 전체)
    await updateView(ref.collection, ownerActor, 'baseline', { state: { ...state, q: null } })
    const all = (await rest(ref.collection.slug, 'view=baseline&limit=1')).body.page.total
    expect(all).toBeGreaterThan(total)
    expect(await matched('baseline')).toBe(all)
    // 기준선은 사건이 아니다 — 발송 기록이 생기지 않는다
    const sent = await sql<{ n: number }[]>`
      select count(*)::int n from notification_log l join items i on i.id = l.item_id where i.collection_id = ${ref.collection.id}`
    expect(sent[0]?.n).toBe(0)
  })
})
