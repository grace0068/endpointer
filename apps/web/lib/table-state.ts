// 표의 상태 ↔ URL (ADR A46·A47). 순수 함수만 — 테스트가 그대로 돈다.
//
// 표에서 보는 것(조건 · 검색어 · 출처 · 정렬 · 열)은 **전부 주소에 있다.** 그래서 새로고침·뒤로 가기가
// 상태를 되살리고, 저장할 때는 "지금 보는 것" 을 그대로 저장한다. 데이터는 언제나 서버가 그 상태로
// 조회한다 — 브라우저에서 거르지 않는다.
//
// ── 파라미터 규약 ────────────────────────────────────────────────────────
//   d_<key>   date   — 'this_week' | 'this_month' | 0~365 (D-n 이내)
//   e_<key>   enum   — 정규화 키 하나 (in 한 개)
//   min_<key> / max_<key>  number·money
//   q_<key>   text   — 이 칸에 이 말이 들어간 것만 (contains)
//   x         위 넷으로 못 나타내는 조건들(JSON 배열) — 제외 목록·사이 범위·값 없음 …
//             저장된 뷰를 표에서 고칠 때 이 조건들이 **조용히 빠지지 않게** 그대로 실어 나른다
//   q         글자 칸 전체 검색어      source  출처 호스트      sort  `key` | `-key`
//   cols      보일 열과 순서 (쉼표)    base    고치는 중인 저장된 뷰의 slug
//   cursor    이어보기 (조건·정렬이 바뀌면 붙이지 않는다)      view  저장된 뷰 보기 (다른 것과 함께 오지 않는다)
//
// 주소창을 손으로 고쳐 못 읽는 값이 오면 **버리지 않고** 문제로 돌려준다 — 화면은 더 넓은 표 대신
// "주소의 조건을 이해하지 못했다" 를 보여준다 (A46 과 같은 원칙).

import {
  SOURCE_COLUMN_ID,
  ViewConditionSchema,
  pruneViewColumns,
  type FieldDef,
  type ViewCondition,
  type ViewSort,
} from '@endpointer/core'

export interface TableState {
  where: ViewCondition[]
  q: string | null
  source: string | null
  /** 0개 또는 1개 — 표 머리글을 누르면 그 칸 하나로 정렬된다 */
  sort: ViewSort[]
  /** 표시 설정. null = 기본 열 */
  columns: string[] | null
}

export interface TableUrlState extends TableState {
  /** 고치는 중인 저장된 뷰 (있으면 "이 뷰에 덮어쓰기" 가 보인다) */
  base: string | null
}

export const EMPTY_TABLE_STATE: TableUrlState = { where: [], q: null, source: null, sort: [], columns: null, base: null }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const SORT_RE = /^-?[a-z][a-z0-9_]*$/
const BUILTIN_SORT = ['first_seen_at', 'last_seen_at']
const MAX_SEARCH = 200

type RawParams = Readonly<Record<string, string | string[] | undefined>>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export type ParsedTableParams =
  | { ok: true; state: TableUrlState; cursor: string | null; viewSlug: string | null }
  | { ok: false; problems: string[] }

/** 주소 → 표 상태. 못 읽는 값은 문제로 (머리말) */
export function parseTableParams(params: RawParams, fields: readonly FieldDef[]): ParsedTableParams {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const problems: string[] = []
  const where: ViewCondition[] = []
  const state: TableUrlState = { ...EMPTY_TABLE_STATE, where }
  let cursor: string | null = null
  let viewSlug: string | null = null

  for (const [name, rawValue] of Object.entries(params)) {
    if (Array.isArray(rawValue) && rawValue.length > 1) {
      problems.push(`주소에 같은 조건이 두 번 있어요: ${name}`)
      continue
    }
    const value = (first(rawValue) ?? '').trim()
    if (value === '') continue // 폼이 비워 둔 칸 = 조건 없음

    const unreadable = () => problems.push(`주소의 '${name}' 값을 이해하지 못했어요`)

    if (name === 'view') {
      if (SLUG_RE.test(value)) viewSlug = value
      else unreadable()
    } else if (name === 'base') {
      if (SLUG_RE.test(value)) state.base = value
      else unreadable()
    } else if (name === 'cursor') {
      cursor = value
    } else if (name === 'q') {
      if (value.length > MAX_SEARCH) problems.push(`검색어는 ${MAX_SEARCH}자까지 쓸 수 있어요`)
      else state.q = value
    } else if (name === 'source') {
      state.source = value
    } else if (name === 'sort') {
      const key = value.startsWith('-') ? value.slice(1) : value
      if (!SORT_RE.test(value) || (!byKey.has(key) && !BUILTIN_SORT.includes(key))) unreadable()
      else state.sort = [{ field: key, dir: value.startsWith('-') ? 'desc' : 'asc' }]
    } else if (name === 'cols') {
      // 표시 설정 — 지금 없는 열은 조용히 걸러도 된다 (결과를 넓히지 않는다)
      state.columns = pruneViewColumns(
        value.split(',').map((c) => c.trim()).filter((c) => c !== ''),
        fields,
      ).columns
    } else if (name === 'x') {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        unreadable()
        continue
      }
      const conds = ViewConditionSchema.array().max(10).safeParse(parsed)
      if (!conds.success) unreadable()
      else where.push(...conds.data)
    } else if (name.startsWith('d_')) {
      const key = name.slice(2)
      if (byKey.get(key)?.type !== 'date') unreadable()
      else if (value === 'this_week' || value === 'this_month') where.push({ field: key, op: 'within', value })
      else if (/^\d{1,3}$/.test(value) && Number(value) <= 365) where.push({ field: key, op: 'd_within', value: Number(value) })
      else unreadable()
    } else if (name.startsWith('e_')) {
      const key = name.slice(2)
      if (byKey.get(key)?.type !== 'enum') unreadable()
      else where.push({ field: key, op: 'in', value: [value] })
    } else if (name.startsWith('min_') || name.startsWith('max_')) {
      const key = name.slice(4)
      const type = byKey.get(key)?.type
      const n = Number(value.replace(/,/g, ''))
      if ((type !== 'number' && type !== 'money') || !/^-?[\d,]+(\.\d+)?$/.test(value) || !Number.isFinite(n)) unreadable()
      else where.push({ field: key, op: name.startsWith('min_') ? 'gte' : 'lte', value: n })
    } else if (name.startsWith('q_')) {
      const key = name.slice(2)
      if (byKey.get(key)?.type !== 'text') unreadable()
      else if (value.length > MAX_SEARCH) problems.push(`'${byKey.get(key)?.label ?? key}' 검색어는 ${MAX_SEARCH}자까지 쓸 수 있어요`)
      else where.push({ field: key, op: 'contains', value })
    } else {
      problems.push(`주소에 모르는 조건이 있어요: ${name}`)
    }
  }

  if (viewSlug !== null && Object.keys(params).some((n) => n !== 'view' && n !== 'cursor' && first(params[n])?.trim())) {
    problems.push('저장된 조건을 볼 때는 다른 조건을 함께 줄 수 없어요')
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, state, cursor, viewSlug }
}

/**
 * 조건 → 주소 파라미터. 필터 바가 그릴 수 있는 것은 이름 있는 파라미터로, 나머지는 `x` 로.
 * 같은 파라미터 이름에 조건이 두 개 몰리면 두 번째부터 `x` 로 간다 — 어느 것도 버리지 않는다.
 */
export function conditionsToParams(
  conds: readonly ViewCondition[],
  fields: readonly FieldDef[],
): { named: Record<string, string>; extra: ViewCondition[] } {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const named: Record<string, string> = {}
  const extra: ViewCondition[] = []

  const put = (name: string, value: string, cond: ViewCondition) => {
    if (named[name] !== undefined) extra.push(cond)
    else named[name] = value
  }

  for (const cond of conds) {
    const type = byKey.get(cond.field)?.type
    switch (cond.op) {
      case 'within':
        put(`d_${cond.field}`, cond.value, cond)
        break
      case 'd_within':
        put(`d_${cond.field}`, String(cond.value), cond)
        break
      case 'in':
        if (cond.value.length === 1 && cond.value[0] !== undefined && type === 'enum') put(`e_${cond.field}`, cond.value[0], cond)
        else extra.push(cond)
        break
      case 'gte':
        if (type === 'number' || type === 'money') put(`min_${cond.field}`, String(cond.value), cond)
        else extra.push(cond)
        break
      case 'lte':
        if (type === 'number' || type === 'money') put(`max_${cond.field}`, String(cond.value), cond)
        else extra.push(cond)
        break
      case 'contains':
        if (type === 'text') put(`q_${cond.field}`, cond.value, cond)
        else extra.push(cond)
        break
      default:
        extra.push(cond)
    }
  }
  return { named, extra }
}

/** 상태 → 주소 파라미터 (순서가 늘 같다 — 같은 상태면 같은 주소) */
export function tableStateToParams(
  state: TableUrlState,
  fields: readonly FieldDef[],
  opts: { cursor?: string | null } = {},
): URLSearchParams {
  const out = new URLSearchParams()
  const { named, extra } = conditionsToParams(state.where, fields)
  for (const name of Object.keys(named).sort()) out.set(name, named[name] as string)
  if (extra.length > 0) out.set('x', JSON.stringify(extra))
  if (state.q !== null && state.q !== '') out.set('q', state.q)
  if (state.source !== null && state.source !== '') out.set('source', state.source)
  const s = state.sort[0]
  if (s !== undefined) out.set('sort', s.dir === 'desc' ? `-${s.field}` : s.field)
  if (state.columns !== null) out.set('cols', state.columns.join(','))
  if (state.base !== null) out.set('base', state.base)
  if (opts.cursor) out.set('cursor', opts.cursor)
  return out
}

export function tableHref(
  basePath: string,
  state: TableUrlState,
  fields: readonly FieldDef[],
  opts: { cursor?: string | null } = {},
): string {
  const qs = tableStateToParams(state, fields, opts).toString()
  return qs === '' ? basePath : `${basePath}?${qs}`
}

/** 조회 상태가 비어 있나 (표시 설정·base 는 안 본다) */
export function hasQueryState(state: QueryPart): boolean {
  return state.where.length > 0 || state.q !== null || state.source !== null || state.sort.length > 0
}

/** 두 조회 상태가 같은가 — "저장된 뷰에서 바뀌었나" 판단용 */
type QueryPart = Pick<TableState, 'where' | 'q' | 'source' | 'sort'>

export function sameQueryState(a: QueryPart, b: QueryPart): boolean {
  const norm = (s: QueryPart) =>
    JSON.stringify({ where: s.where, q: s.q ?? null, source: s.source ?? null, sort: s.sort.slice(0, 1) })
  return norm(a) === norm(b)
}

export function sameColumns(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 기본 열 순서 — 출처가 맨 앞, **원문 링크(link 타입)는 맨 뒤.**
 * 링크는 값이 아니라 "원문 보기" 버튼이라 가운데 끼면 표가 읽기 나빠진다.
 */
export function defaultColumnOrder(fields: readonly FieldDef[]): string[] {
  const links: string[] = []
  const rest: string[] = []
  for (const f of fields) (f.type === 'link' ? links : rest).push(f.key)
  return [SOURCE_COLUMN_ID, ...rest, ...links]
}
