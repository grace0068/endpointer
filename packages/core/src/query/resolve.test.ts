// 공통 조회 해석 (ADR A46·A47) — DB 없이 검증되는 부분.
// DB 를 타는 부분(실제 페이지 이동·표면 간 일치)은 query.db.test.ts 가 본다.

import { describe, expect, it } from 'vitest'

import type { CollectionQuery } from '../types/api'
import type { FieldDef } from '../types/collection'
import type { ViewQueryState } from '../types/view'
import { queryFingerprint } from './build'
import { encodeCursor, parseCollectionQuery } from './params'
import {
  checkCursor,
  overlayQueries,
  parseStoredView,
  resolveCollectionRequest,
  summarizeProblems,
  type StoredViewRow,
} from './resolve'
import { viewToQuery } from './view'

const FIELDS: FieldDef[] = [
  { key: 'title', label: '사업명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  { key: 'category', label: '분야', type: 'enum', required: false, mapping: { 'R&D': 'rnd' }, value_labels: null },
  { key: 'link', label: '원문', type: 'link', required: false, mapping: null, value_labels: null },
]

/** 2026-08-10 (월) 12:00 KST */
const NOW = new Date('2026-08-10T03:00:00.000Z')
const UUID = '11111111-1111-1111-1111-111111111111'

function q(qs: string): CollectionQuery {
  const r = parseCollectionQuery(qs, FIELDS)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.query
}

const STATE: ViewQueryState = {
  where: [
    { field: 'amount', op: 'gte', value: 50_000_000 },
    { field: 'category', op: 'in', value: ['rnd'] },
  ],
  sort: [{ field: 'deadline', dir: 'asc' }],
  q: '청년',
  source: 'k-startup.go.kr',
}

describe('overlayQueries — 뷰 위에는 AND 로만 얹는다 (뷰를 넓힐 수 없다)', () => {
  const base = viewToQuery(STATE, NOW)

  it('범위는 좁은 쪽이 이긴다 — 요청이 더 넓은 범위를 줘도 뷰보다 넓어지지 않는다', () => {
    const wider = overlayQueries(base, q('amount_gte=0'))
    const narrower = overlayQueries(base, q('amount_gte=90000000'))
    expect(wider.ok && wider.query.gte['amount']).toBe(50_000_000)
    expect(narrower.ok && narrower.query.gte['amount']).toBe(90_000_000)
  })

  it('뷰에만 있는 술어(in)는 그대로 간다', () => {
    const r = overlayQueries(base, q('limit=5'))
    expect(r.ok && r.query.in).toEqual({ category: ['rnd'] })
  })

  it('검색어가 다르면 둘 중 하나를 고르지 않고 거절한다', () => {
    const r = overlayQueries(base, q('q=창업'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems[0]).toMatchObject({ code: 'invalid_query', param: 'q' })
  })

  it('같은 검색어·같은 출처(대소문자·www 무시)는 문제없다', () => {
    expect(overlayQueries(base, q('q=청년&source=WWW.k-startup.go.kr')).ok).toBe(true)
  })

  it('다른 출처는 거절', () => {
    const r = overlayQueries(base, q('source=bizinfo.go.kr'))
    expect(r.ok).toBe(false)
  })

  it('같은 칸 완전일치가 서로 다르면 거절', () => {
    const withEq: CollectionQuery = { ...base, eq: { category: 'rnd' } }
    const r = overlayQueries(withEq, q('category=startup'))
    expect(r.ok).toBe(false)
  })

  it('정렬·개수·커서는 요청이 정한다 (결과 집합을 넓히지 않는다)', () => {
    const r = overlayQueries(base, q('sort=-amount&limit=7'))
    expect(r.ok && r.query.sort).toBe('-amount')
    expect(r.ok && r.query.limit).toBe(7)
  })

  it('정렬을 안 주면 뷰의 정렬', () => {
    const r = overlayQueries(base, q(''))
    expect(r.ok && r.query.sort).toBe('deadline')
  })

  it('since 는 늦은 쪽(좁은 쪽)', () => {
    const b: CollectionQuery = { ...base, since: '2026-08-01' }
    const r = overlayQueries(b, q('since=2026-07-01'))
    expect(r.ok && r.query.since).toBe('2026-08-01')
  })
})

describe('checkCursor — 이 요청의 이어보기인가', () => {
  const query = q('category=rnd&sort=deadline')
  const fp = queryFingerprint(query)

  it('같은 조건·정렬의 커서는 통과', () => {
    const cursor = encodeCursor({ s: '2026-08-01', id: UUID, f: fp, o: 50 })
    expect(checkCursor({ ...query, cursor }, FIELDS)).toBeNull()
  })

  it('정렬을 바꾼 요청에 옛 커서를 붙이면 invalid_cursor', () => {
    const cursor = encodeCursor({ s: '2026-08-01', id: UUID, f: fp, o: 50 })
    const changed = q('category=rnd&sort=-amount')
    const problem = checkCursor({ ...changed, cursor }, FIELDS)
    expect(problem).toMatchObject({ code: 'invalid_cursor', param: 'cursor' })
    expect(problem?.message).toContain('처음부터')
  })

  it('조건을 바꿔도 invalid_cursor', () => {
    const cursor = encodeCursor({ s: '2026-08-01', id: UUID, f: fp, o: 50 })
    expect(checkCursor({ ...q('category=startup&sort=deadline'), cursor }, FIELDS)?.code).toBe('invalid_cursor')
  })

  it('지문은 맞지만 정렬값이 정렬과 안 맞는 커서도 거절 (시각 정렬인데 값이 비었다)', () => {
    const byTime = q('')
    const cursor = encodeCursor({ s: null, id: UUID, f: queryFingerprint(byTime), o: 0 })
    expect(checkCursor({ ...byTime, cursor }, FIELDS)?.code).toBe('invalid_cursor')
  })
})

describe('resolveCollectionRequest', () => {
  it('뷰 없이 — 파라미터 그대로', () => {
    const r = resolveCollectionRequest({ fields: FIELDS, params: 'category=rnd', now: NOW })
    expect(r.ok && r.query.eq).toEqual({ category: 'rnd' })
  })

  it('파라미터 문제는 그대로 실패로 — 뷰를 얹기 전에 멈춘다', () => {
    const r = resolveCollectionRequest({ fields: FIELDS, params: 'categroy=rnd', base: STATE, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('상대 날짜는 조회 시각 기준으로 풀린다 — 저장된 값은 상대 표현 그대로', () => {
    const state: ViewQueryState = { where: [{ field: 'deadline', op: 'd_within', value: 7 }], sort: [], q: null, source: null }
    const a = resolveCollectionRequest({ fields: FIELDS, params: '', base: state, now: NOW })
    const b = resolveCollectionRequest({
      fields: FIELDS,
      params: '',
      base: state,
      now: new Date('2026-08-20T03:00:00.000Z'),
    })
    expect(a.ok && a.query.gte['deadline']).toBe('2026-08-10')
    expect(a.ok && a.query.lte['deadline']).toBe('2026-08-17')
    expect(b.ok && b.query.gte['deadline']).toBe('2026-08-20')
    expect(state.where[0]).toEqual({ field: 'deadline', op: 'd_within', value: 7 })
  })

  it('뷰 위의 커서는 뷰를 포함한 지문이어야 한다', () => {
    const first = resolveCollectionRequest({ fields: FIELDS, params: 'limit=5', base: STATE, now: NOW })
    if (!first.ok) throw new Error('첫 요청이 실패')
    const cursor = encodeCursor({ s: '2026-08-01', id: UUID, f: queryFingerprint(first.query), o: 5 })
    const next = resolveCollectionRequest({ fields: FIELDS, params: `limit=5&cursor=${cursor}`, base: STATE, now: NOW })
    expect(next.ok).toBe(true)
    // 같은 커서를 뷰 없이 쓰면 다른 요청이다
    const bare = resolveCollectionRequest({ fields: FIELDS, params: `limit=5&cursor=${cursor}`, now: NOW })
    expect(bare.ok).toBe(false)
  })
})

describe('parseStoredView — 조회 상태와 표시 설정 (A47)', () => {
  const row = (over: Partial<StoredViewRow>): StoredViewRow => ({
    id: UUID,
    slug: 'big-rnd',
    name: '큰 R&D',
    where_json: [{ field: 'amount', op: 'gte', value: 50_000_000 }],
    sort_json: [{ field: 'deadline', dir: 'asc' }],
    search_q: null,
    source_host: null,
    columns_json: null,
    notify_json: null,
    pinned: false,
    created_at: null,
    ...over,
  })

  it('예전 뷰(검색어·출처 칸이 없던 때)도 그대로 읽힌다', () => {
    const view = parseStoredView(row({}), FIELDS, ['k-startup.go.kr'])
    expect(view.health).toBe('ok')
    expect(view.state).toEqual({
      where: [{ field: 'amount', op: 'gte', value: 50_000_000 }],
      sort: [{ field: 'deadline', dir: 'asc' }],
      q: null,
      source: null,
    })
  })

  it('검색어·출처까지 조회 상태로 읽힌다', () => {
    const view = parseStoredView(row({ search_q: '청년', source_host: 'k-startup.go.kr' }), FIELDS, ['k-startup.go.kr'])
    expect(view.state.q).toBe('청년')
    expect(view.state.source).toBe('k-startup.go.kr')
  })

  it('사라진 열은 표시에서만 걸러지고 뷰는 멀쩡하다 — 표시 문제로 조회가 멈추지 않는다', () => {
    const view = parseStoredView(row({ columns_json: ['_source', 'title', 'gone', 'amount'] }), FIELDS)
    expect(view.health).toBe('ok')
    expect(view.columns).toEqual(['_source', 'title', 'amount'])
    expect(view.droppedColumns).toEqual(['gone'])
  })

  it('조건의 칸이 사라지면 broken + 이유', () => {
    const view = parseStoredView(row({ where_json: [{ field: 'budget', op: 'gte', value: 1 }] }), FIELDS)
    expect(view.health).toBe('broken')
    expect(view.problems.join(' ')).toContain('budget')
  })

  it('저장된 출처가 컬렉션에서 빠지면 broken — 조용히 0건이 되지 않게', () => {
    const view = parseStoredView(row({ source_host: 'gone.example' }), FIELDS, ['k-startup.go.kr'])
    expect(view.health).toBe('broken')
    expect(view.problems.join(' ')).toContain('gone.example')
  })

  it('정렬 칸이 사라져도 broken (정렬은 조회 상태다)', () => {
    expect(parseStoredView(row({ sort_json: [{ field: 'gone', dir: 'asc' }] }), FIELDS).health).toBe('broken')
  })

  it('모양이 깨진 jsonb 는 broken', () => {
    expect(parseStoredView(row({ where_json: [{ field: 'amount', op: 'eval' }] }), FIELDS).health).toBe('broken')
  })
})

describe('summarizeProblems', () => {
  it('하나면 그 문장, 여럿이면 개수와 함께', () => {
    expect(summarizeProblems([{ code: 'invalid_query', message: 'A' }])).toBe('A')
    expect(
      summarizeProblems([
        { code: 'invalid_query', message: 'A' },
        { code: 'invalid_query', message: 'B' },
      ]),
    ).toContain('2개')
  })
})
