// SQL 조립은 DB 없이도 검증할 수 있다 — drizzle 의 방언으로 문자열과 파라미터를 뽑아 본다.
// 여기서 지키는 것은 두 가지다:
//   1. 사용자 입력이 SQL 문자열에 절대 섞이지 않는다 (전부 $n 바인딩)
//   2. 정렬·커서가 안정 정렬 규약(NULLS LAST + id tie-break)과 어긋나지 않는다

import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { CollectionQuerySchema, type CollectionQuery } from '../types/api'
import type { FieldDef } from '../types/collection'
import {
  buildCursorWhere,
  buildItemsWhere,
  buildOrderBy,
  escapeLikePattern,
  planItemsQuery,
  queryFingerprint,
  resolveSort,
  sortValueOf,
} from './build'
import { encodeCursor, parseCollectionQuery } from './params'

const dialect = new PgDialect()
const render = (fragment: SQL) => dialect.sqlToQuery(fragment)

const FIELDS: FieldDef[] = [
  { key: 'title', label: '사업명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'organization', label: '주관기관', type: 'text', required: false, mapping: null, value_labels: null },
  { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  { key: 'category', label: '분야', type: 'enum', required: false, mapping: { 'R&D': 'rnd' }, value_labels: null },
  { key: 'link', label: '원문', type: 'link', required: true, mapping: null, value_labels: null },
]

const COLLECTION_ID = '00000000-0000-0000-0000-0000000000c1'

function parsed(qs: string, fields: readonly FieldDef[] = FIELDS): CollectionQuery {
  const result = parseCollectionQuery(qs, fields)
  if (!result.ok) throw new Error(JSON.stringify(result.problems))
  return result.query
}

function plan(qs: string, sourceIds: string[] | null = null) {
  return planItemsQuery(parsed(qs), { collectionId: COLLECTION_ID, fields: FIELDS, sourceIds })
}

const ROW_ID = '00000000-0000-0000-0000-00000000beef'

describe('SQL 안전성', () => {
  it('필드 키와 값이 전부 파라미터로 나간다', () => {
    const p = plan('category=rnd&deadline_gte=2026-08-01&amount_lte=100000000&q=창업')
    const { sql: text, params } = render(p.pageWhere)
    expect(text).not.toContain('rnd')
    expect(text).not.toContain('창업')
    expect(text).not.toContain('2026-08-01')
    expect(params).toContain('{"category":"rnd"}')
    expect(params).toContain('2026-08-01')
    expect(params).toContain('%창업%')
  })

  it('작은따옴표를 넣어도 문자열이 끊기지 않는다', () => {
    const evil = "'); drop table items; --"
    const p = plan(`title=${encodeURIComponent(evil)}&q=${encodeURIComponent(evil)}`)
    const { sql: text, params } = render(p.pageWhere)
    expect(text.toLowerCase()).not.toContain('drop table')
    expect(params.some((v) => typeof v === 'string' && v.includes('drop table'))).toBe(true)
  })

  it('스키마에 없는 이름은 조건이 되지 않는다 — 파싱이 거절하고, 우회해도 SQL 에 닿지 않는다', () => {
    // 1겹: 파싱이 거절한다 (A46)
    expect(parseCollectionQuery('ghost=1&ghost_gte=1', FIELDS).ok).toBe(false)
    // 2겹: 파싱을 우회한 쿼리를 넣어도 화이트리스트가 거른다
    const bare = render(buildItemsWhere(CollectionQuerySchema.parse({}), { collectionId: COLLECTION_ID, fields: FIELDS })).sql
    const junk = CollectionQuerySchema.parse({ eq: { ghost: '1' }, gte: { ghost: 1 } })
    const withJunk = render(buildItemsWhere(junk, { collectionId: COLLECTION_ID, fields: FIELDS })).sql
    expect(withJunk).toBe(bare)
  })

  it('ILIKE 메타문자를 죽인다', () => {
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b')
    const { params } = render(plan('q=100%').pageWhere)
    expect(params).toContain('%100\\%%')
  })
})

describe('조건 조립', () => {
  it('컬렉션 조건은 언제나 들어간다', () => {
    expect(render(plan('').where).params).toContain(COLLECTION_ID)
  })

  it('완전일치는 GIN 인덱스를 타도록 JSONB 포함 연산자로 나간다', () => {
    const { sql: text, params } = render(plan('category=rnd').where)
    expect(text).toContain('@>')
    expect(params).toContain('{"category":"rnd"}')
  })

  it('money 범위는 숫자로 캐스팅해 비교한다', () => {
    const { sql: text, params } = render(plan('amount_gte=1000').where)
    expect(text).toContain('::numeric')
    expect(params).toContain(1000)
  })

  it('date 범위는 정규화된 YYYY-MM-DD 라 문자열 비교로 충분하다', () => {
    const { sql: text } = render(plan('deadline_lte=2026-08-01').where)
    expect(text).not.toContain('::date')
    expect(text).toContain('::text')
  })

  it('?source= 가 아무 출처와도 안 맞으면 결과가 0건이 된다', () => {
    expect(render(plan('', []).where).sql).toContain('false')
  })

  it('?since= 는 first_seen_at 기준이다', () => {
    const { sql: text, params } = render(plan('since=2026-07-20').where)
    expect(text).toContain('first_seen_at')
    expect(params).toContain('2026-07-20')
  })

  it('text 필드가 없는데 q 가 여기까지 오면 버리지 않고 닫는다 — 더 넓은 결과가 안 나간다 (A46)', () => {
    const onlyDate: FieldDef[] = [
      { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
    ]
    // 파싱은 이걸 거절한다(params.test). 여기서는 그 관문을 우회한 쿼리가 어떻게 되는지 본다
    const where = buildItemsWhere(CollectionQuerySchema.parse({ q: '창업' }), { collectionId: COLLECTION_ID, fields: onlyDate })
    const text = render(where).sql
    expect(text).not.toContain('ilike')
    expect(text).toContain('false')
  })
})

describe('정렬과 커서', () => {
  it('언제나 id 로 동률을 깬다 (안정 정렬)', () => {
    for (const spec of [undefined, 'deadline', '-amount', '-first_seen_at']) {
      const order = buildOrderBy(resolveSort(spec, FIELDS))
      expect(order).toHaveLength(2)
      expect(render(order[1]!).sql).toContain('"id" asc')
      expect(render(order[0]!).sql).toContain('nulls last')
    }
  })

  it('커서가 붙으면 where 가 늘어나고, 커서의 위치가 offset 이 된다', () => {
    const fp = queryFingerprint(parsed('sort=deadline'))
    const cursor = encodeCursor({ s: '2026-08-01', id: ROW_ID, f: fp, o: 50 })
    const p = plan(`sort=deadline&cursor=${cursor}`)
    expect(render(p.pageWhere).sql.length).toBeGreaterThan(render(p.where).sql.length)
    expect(p.offset).toBe(50)
  })

  const cursorOf = (s: string | null) => ({ v: 2 as const, s, id: ROW_ID, f: 'fp', o: 0 })

  it('오름차순 커서는 뒤쪽 + 동률-id + 빈 값 구간을 집는다', () => {
    const sort = resolveSort('deadline', FIELDS)
    const text = render(buildCursorWhere(sort, cursorOf('2026-08-01'))!).sql
    expect(text).toContain('>')
    expect(text).toContain('is null')
  })

  it('내림차순 커서는 앞쪽을 집는다', () => {
    const sort = resolveSort('-deadline', FIELDS)
    const text = render(buildCursorWhere(sort, cursorOf('2026-08-01'))!).sql
    expect(text).toContain('<')
  })

  it('빈 값 구간에 들어온 커서는 id 로만 이어간다', () => {
    const sort = resolveSort('deadline', FIELDS)
    const text = render(buildCursorWhere(sort, cursorOf(null))!).sql
    expect(text).toContain('is null')
    expect(text).not.toContain('>=')
  })

  it('값이 비지 않는 기준인데 커서에 값이 없으면 쓸 수 없는 커서다', () => {
    const sort = resolveSort('-first_seen_at', FIELDS)
    expect(buildCursorWhere(sort, cursorOf(null))).toBeNull()
  })

  it('검증을 안 거친 깨진 커서가 조회까지 오면 처음부터 주지 않고 멈춘다 (같은 행을 두 번 주지 않는다)', () => {
    const q: CollectionQuery = CollectionQuerySchema.parse({ cursor: 'garbage' })
    expect(() => planItemsQuery(q, { collectionId: COLLECTION_ID, fields: FIELDS })).toThrow()
  })

  it('시각 정렬은 밀리초로 자른 값으로 정렬·비교한다 — 같은 트랜잭션의 마이크로초 동률이 새지 않게', () => {
    const order = render(buildOrderBy(resolveSort(undefined, FIELDS))[0]!).sql
    expect(order).toContain("date_trunc('milliseconds'")
    const where = render(buildCursorWhere(resolveSort(undefined, FIELDS), cursorOf('2026-07-20T00:00:00.123Z'))!).sql
    expect(where).toContain("date_trunc('milliseconds'")
  })
})

describe('커서 정렬값은 SQL 식과 같은 규칙으로 뽑는다', () => {
  const row = (data: Record<string, unknown>) => ({
    id: ROW_ID,
    data_json: data,
    first_seen_at: new Date('2026-07-20T00:00:00.123Z'),
    last_seen_at: new Date('2026-07-21T00:00:00.000Z'),
  })

  it('숫자 칸: 숫자꼴 문자열은 숫자, 숫자가 아닌 값은 null (NUMERIC_GUARD 와 같다)', () => {
    const sort = resolveSort('amount', FIELDS)
    expect(sortValueOf(row({ amount: 100 }), sort)).toBe(100)
    expect(sortValueOf(row({ amount: '2500' }), sort)).toBe(2500)
    expect(sortValueOf(row({ amount: '약 1억' }), sort)).toBeNull()
    expect(sortValueOf(row({ amount: true }), sort)).toBeNull()
  })

  it('글자 칸: ->> 가 내는 글자 그대로 — 불리언·숫자도 글자가 된다', () => {
    const sort = resolveSort('title', FIELDS)
    expect(sortValueOf(row({ title: true }), sort)).toBe('true')
    expect(sortValueOf(row({ title: 7 }), sort)).toBe('7')
    expect(sortValueOf(row({ title: '' }), sort)).toBe('')
    expect(sortValueOf(row({}), sort)).toBeNull()
  })

  it('시각: 밀리초 ISO', () => {
    expect(sortValueOf(row({}), resolveSort('-first_seen_at', FIELDS))).toBe('2026-07-20T00:00:00.123Z')
  })
})

describe('조건 지문', () => {
  it('정렬을 안 준 요청과 기본 정렬을 명시한 요청은 같은 지문', () => {
    expect(queryFingerprint(parsed(''))).toBe(queryFingerprint(parsed('sort=-first_seen_at')))
  })

  it('개수·커서·include 는 지문을 바꾸지 않는다', () => {
    expect(queryFingerprint(parsed('category=rnd'))).toBe(queryFingerprint(parsed('category=rnd&limit=7&include=provenance')))
  })

  it('조건·정렬이 바뀌면 지문이 바뀐다', () => {
    const base = queryFingerprint(parsed('category=rnd'))
    expect(queryFingerprint(parsed('category=startup'))).not.toBe(base)
    expect(queryFingerprint(parsed('category=rnd&sort=deadline'))).not.toBe(base)
    expect(queryFingerprint(parsed('category=rnd&q=청년'))).not.toBe(base)
  })
})

describe('페이지', () => {
  it('다음 페이지 유무를 알려고 하나 더 읽는다', () => {
    const p = plan('limit=10')
    expect(p.limit).toBe(10)
    expect(p.fetchLimit).toBe(11)
  })
})

describe('뷰 술어 (A33·A35) — 같은 안전성 규약을 지킨다', () => {
  function planQuery(partial: Record<string, unknown>) {
    const q: CollectionQuery = CollectionQuerySchema.parse(partial)
    return planItemsQuery(q, { collectionId: COLLECTION_ID, fields: FIELDS })
  }

  it('in 은 완전일치(@>)의 OR — 값은 전부 바인딩된다', () => {
    const p = planQuery({ in: { category: ['rnd', 'startup'] } })
    const { sql: text, params } = render(p.where)
    expect(text).toContain(' or ')
    expect(text).toContain('@>')
    expect(text).not.toContain('rnd') // 값이 SQL 문자열에 섞이면 안 된다
    expect(params.some((v) => String(v).includes('rnd'))).toBe(true)
  })

  it('not_in 은 not(...) — 값이 비어 있는 행도 "목록에 없음"으로 포함된다', () => {
    const p = planQuery({ not_in: { category: ['rnd'] } })
    expect(render(p.where).sql).toContain('not (')
  })

  it('contains 는 필드 하나 대상 ilike — 메타문자는 이스케이프된다', () => {
    const p = planQuery({ contains: { title: '100%' } })
    const { sql: text, params } = render(p.where)
    expect(text).toContain('ilike')
    expect(params).toContain('%100\\%%')
  })

  it('is_null 은 빈 문자열도 "비어 있음"으로 본다 (상시 가 어느 쪽으로 저장돼도)', () => {
    const p = planQuery({ is_null: ['deadline'] })
    expect(render(p.where).sql).toContain('nullif')
  })

  it('스키마에 없는 키는 어느 술어로도 SQL 에 닿지 않는다', () => {
    const p = planQuery({
      in: { ghost: ['x'] },
      not_in: { ghost: ['x'] },
      contains: { ghost: 'x' },
      not_contains: { ghost: 'x' },
      is_null: ['ghost'],
    })
    const { sql: text, params } = render(p.where)
    expect(text).not.toContain('ghost')
    expect(params.every((v) => !String(v).includes('ghost'))).toBe(true)
  })
})
