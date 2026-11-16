// 표 상태 ↔ 주소 (ADR A46·A47) — 새로고침·뒤로 가기·뷰 저장이 같은 상태를 되살리는가
import { describe, expect, it } from 'vitest'

import type { FieldDef, ViewCondition } from '@endpointer/core'

import {
  conditionsToParams,
  defaultColumnOrder,
  parseTableParams,
  sameQueryState,
  tableHref,
  tableStateToParams,
  type TableUrlState,
} from './table-state'

const FIELDS: FieldDef[] = [
  { key: 'title', label: '공고명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'benefit', label: '혜택', type: 'text', required: false, mapping: null, value_labels: null },
  { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  { key: 'category', label: '분야', type: 'enum', required: false, mapping: { 'R&D': 'rnd' }, value_labels: null },
  { key: 'link', label: '원문', type: 'link', required: false, mapping: null, value_labels: null },
]

function ok(params: Record<string, string>) {
  const r = parseTableParams(params, FIELDS)
  if (!r.ok) throw new Error(r.problems.join(' / '))
  return r
}

describe('주소 → 상태', () => {
  it('필터 바 파라미터가 조건이 된다', () => {
    const { state } = ok({ d_deadline: '7', e_category: 'rnd', min_amount: '1,000', q_benefit: '할인' })
    expect(state.where).toEqual([
      { field: 'deadline', op: 'd_within', value: 7 },
      { field: 'category', op: 'in', value: ['rnd'] },
      { field: 'amount', op: 'gte', value: 1000 },
      { field: 'benefit', op: 'contains', value: '할인' },
    ])
  })

  it('검색어·출처·정렬·열·고치는 중인 뷰·커서', () => {
    const r = ok({ q: '청년', source: 'a.kr', sort: '-amount', cols: '_source,title,gone', base: 'big', cursor: 'abc' })
    expect(r.state).toMatchObject({
      q: '청년',
      source: 'a.kr',
      sort: [{ field: 'amount', dir: 'desc' }],
      // 없는 열은 표시에서만 걸러진다 (결과를 넓히지 않는다)
      columns: ['_source', 'title'],
      base: 'big',
    })
    expect(r.cursor).toBe('abc')
  })

  it('빈 값은 조건 없음 — 폼이 비워 둔 칸', () => {
    expect(ok({ d_deadline: '', q: '  ' }).state.where).toEqual([])
  })

  it('못 읽는 값은 버리지 않고 문제로 — 더 넓은 표를 그리지 않는다 (A46)', () => {
    for (const bad of [
      { d_deadline: 'next_year' },
      { d_title: 'this_week' }, // 날짜 칸이 아니다
      { min_amount: '많이' },
      { e_title: 'x' },
      { sort: 'ghost' },
      { x: '{깨진' },
      { x: JSON.stringify([{ field: 'amount', op: 'eval', value: 1 }]) },
      { surprise: '1' },
      { view: 'big', q: '청년' }, // 저장된 뷰를 보며 다른 조건을 함께 줄 수 없다
    ]) {
      expect(parseTableParams(bad, FIELDS).ok).toBe(false)
    }
  })

  it('같은 이름이 두 번이면 문제', () => {
    expect(parseTableParams({ q: ['a', 'b'] }, FIELDS).ok).toBe(false)
  })
})

describe('상태 → 주소 → 상태 (왕복)', () => {
  const extra: ViewCondition[] = [
    { field: 'category', op: 'not_in', value: ['rnd'] },
    { field: 'amount', op: 'between', value: [1, 100] },
    { field: 'deadline', op: 'is_null' },
  ]
  const state: TableUrlState = {
    where: [{ field: 'deadline', op: 'within', value: 'this_month' }, { field: 'benefit', op: 'contains', value: '할인' }, ...extra],
    q: '청년',
    source: 'a.kr',
    sort: [{ field: 'deadline', dir: 'asc' }],
    columns: ['_source', 'title', 'deadline'],
    base: 'big',
  }

  it('필터 바가 못 그리는 조건(제외 목록·사이 범위·값 없음)도 x 로 살아남는다 — 뷰를 고칠 때 조용히 빠지지 않게', () => {
    const params = Object.fromEntries(tableStateToParams(state, FIELDS))
    const back = ok(params).state
    expect(back.where).toHaveLength(state.where.length)
    expect(back.where).toEqual(expect.arrayContaining(state.where))
    expect(back).toMatchObject({ q: '청년', source: 'a.kr', sort: state.sort, columns: state.columns, base: 'big' })
  })

  it('같은 파라미터에 조건이 둘이면 두 번째는 x 로 간다 — 아무것도 버리지 않는다', () => {
    const { named, extra: ex } = conditionsToParams(
      [
        { field: 'deadline', op: 'within', value: 'this_week' },
        { field: 'deadline', op: 'd_within', value: 3 },
      ],
      FIELDS,
    )
    expect(named).toEqual({ d_deadline: 'this_week' })
    expect(ex).toEqual([{ field: 'deadline', op: 'd_within', value: 3 }])
  })

  it('커서는 주면만 붙는다 — 조건이 바뀌는 주소에는 싣지 않는다', () => {
    expect(tableHref('/t', state, FIELDS)).not.toContain('cursor=')
    expect(tableHref('/t', state, FIELDS, { cursor: 'c1' })).toContain('cursor=c1')
  })

  it('같은 상태면 같은 주소 (순서가 늘 같다)', () => {
    expect(tableHref('/t', state, FIELDS)).toBe(tableHref('/t', { ...state }, FIELDS))
  })
})

describe('보조', () => {
  it('조회 상태 비교는 열·base 를 안 본다', () => {
    const a = { where: [], q: null, source: null, sort: [] }
    expect(sameQueryState(a, { ...a })).toBe(true)
    expect(sameQueryState(a, { ...a, q: 'x' })).toBe(false)
  })

  it('기본 열 순서 — 출처 먼저, 링크 맨 뒤', () => {
    expect(defaultColumnOrder(FIELDS)).toEqual(['_source', 'title', 'benefit', 'deadline', 'amount', 'category', 'link'])
  })
})
