// 컬렉션 쿼리 파라미터 파싱 — 기획서 12장 REST 계약의 단일 출처
//
// 왜 core 에 있나: web 의 `GET /api/v1/{slug}` · mcp 의 도구 · 웹 표가 같은 코드를 써야
// 세 표면의 동작이 갈라지지 않는다. 파라미터 표를 두 번 구현하면 반드시 갈라진다.
//
// ── 원칙 (ADR A46) ───────────────────────────────────────────────────────
//  1. **절대 throw 하지 않는다.** 남이 준 문자열이다. 실패는 값으로 돌려준다.
//  2. **적용할 수 없는 조건은 거절한다.** 예전에는 버리고 경고만 남겼는데, 그러면 오타 하나로
//     "마감 임박만" 이 "전부" 가 되고 클라이언트는 그걸 성공으로 읽는다 — 더 넓은 결과를
//     조용히 내는 것은 실패보다 나쁘다. 문제는 전부 모아서 한 번에 돌려준다.
//  3. 예외는 하나 — **빈 값은 "조건 없음"** 이다 (`?category=`). 폼이 비워 둔 칸을 그대로 보내는
//     관례라 막으면 쓸 수가 없다. 문서(docs/api.md)에 적혀 있다.
//
// 문제 문구는 사람(또는 사용자의 AI)이 그대로 읽는다 — 한국어이고 내부 명사를 쓰지 않는다 (B2·B4).

import {
  CollectionQuerySchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  SORT_PATTERN,
  type CollectionQuery,
  type QueryProblem,
} from '../types/api'
import type { FieldDef, FieldType } from '../types/collection'

// ── 파라미터 이름 규약 ───────────────────────────────────────────────────

/** 스키마 필드 키로 쓸 수 없는(=제어용으로 예약된) 파라미터 이름 */
export const RESERVED_PARAMS = ['q', 'source', 'since', 'sort', 'limit', 'cursor', 'include'] as const

/** 범위 조건 접미사 — `?deadline_gte=…` · `?amount_lte=…` */
export const RANGE_SUFFIXES = ['_gte', '_lte'] as const
export type RangeSuffix = (typeof RANGE_SUFFIXES)[number]

/** 범위 비교가 말이 되는 타입만. 기획서 12장 "date/number/money 타입에만" */
export const RANGE_FIELD_TYPES: readonly FieldType[] = ['date', 'number', 'money']

/**
 * 스키마 필드가 아니지만 정렬 기준으로 허용하는 키.
 * `first_seen_at` 은 `?since=` 의 기준이기도 하다 (기획서 10장 `items.first_seen_at`).
 */
export const BUILTIN_SORT_KEYS = ['first_seen_at', 'last_seen_at'] as const
export type BuiltinSortKey = (typeof BUILTIN_SORT_KEYS)[number]

/** 정렬을 안 걸면 최근에 처음 발견된 것부터 */
export const DEFAULT_SORT_KEY: BuiltinSortKey = 'first_seen_at'
export const DEFAULT_SORT_DIRECTION = 'desc' as const
/** 정렬을 안 걸었을 때의 정렬 문자열 — 커서 지문이 "기본 정렬" 과 "명시한 기본 정렬" 을 같게 본다 */
export const DEFAULT_SORT_SPEC = `-${DEFAULT_SORT_KEY}`

export function isBuiltinSortKey(key: string): key is BuiltinSortKey {
  return (BUILTIN_SORT_KEYS as readonly string[]).includes(key)
}

/** `?sort=` 로 쓸 수 있는가 — 스키마 칸이거나 내장 키 */
export function isSortableKey(key: string, fields: readonly FieldDef[]): boolean {
  return isBuiltinSortKey(key) || fields.some((f) => f.key === key)
}

// ── 입력 ─────────────────────────────────────────────────────────────────

/** URLSearchParams · 쿼리 문자열 · Next 의 searchParams 객체를 전부 받는다 */
export type QueryParamsInput =
  | URLSearchParams
  | string
  | Readonly<Record<string, string | string[] | undefined>>

/** 파싱 결과. 문제가 하나라도 있으면 조건을 적용하지 않는다 (A46) */
export type ParsedCollectionQuery =
  | { ok: true; query: CollectionQuery }
  | { ok: false; problems: QueryProblem[] }

export function toSearchParams(input: QueryParamsInput): URLSearchParams {
  if (input instanceof URLSearchParams) return new URLSearchParams(input)
  if (typeof input === 'string') return new URLSearchParams(input)
  const out = new URLSearchParams()
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) out.append(name, v)
    } else {
      out.append(name, value)
    }
  }
  return out
}

// ── 값 정규화 (순수 · 테스트 대상) ───────────────────────────────────────

/** `YYYY-MM-DD` 로 맞춘다. 달력에 없는 날짜(2026-02-31)는 거부 */
export function normalizeDateValue(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d] = m
  if (y === undefined || mo === undefined || d === undefined) return null
  const iso = `${y}-${mo}-${d}`
  const dt = new Date(`${iso}T00:00:00.000Z`)
  if (Number.isNaN(dt.getTime())) return null
  if (dt.toISOString().slice(0, 10) !== iso) return null
  return iso
}

/** `?since=` 용. 날짜만 오면 날짜 그대로, 시각까지 오면 ISO 문자열로 */
export function normalizeInstantValue(raw: string): string | null {
  const t = raw.trim()
  if (t === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return normalizeDateValue(t)
  // 날짜 꼴이 아닌 것(예: "어제")을 Date 가 너그럽게 읽어 엉뚱한 시각이 되는 걸 막는다
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return null
  const dt = new Date(t)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString()
}

/** 콤마는 빼고 숫자로. money 는 원 단위 정수라 같은 규칙을 쓴다 */
export function normalizeNumberValue(raw: string): number | null {
  const t = raw.trim().replace(/,/g, '')
  if (t === '') return null
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * enum 필드는 정규화된 값(`rnd`)으로 저장돼 있다. 사람이 원문 표기(`R&D`)로 물어볼 수 있으니
 * mapping 에 그 표기가 있으면 정규화된 값으로 바꿔준다. 이미 정규화된 값이면 그대로 둔다.
 */
export function normalizeEnumValue(raw: string, mapping: Record<string, string> | null): string {
  if (!mapping) return raw
  const values = new Set(Object.values(mapping))
  if (values.has(raw)) return raw
  return mapping[raw] ?? raw
}

// ── 커서 (순수 · 왕복 테스트 대상) ───────────────────────────────────────

/**
 * `(정렬값, id)` 복합 커서 + 조건 지문 (ADR A46).
 *
 * - `s`·`id` : 마지막으로 내보낸 행. id 를 같이 실어야 정렬값이 같은 행들 사이에서
 *              안정 정렬이 되고 페이지 경계에서 행이 새거나 겹치지 않는다.
 * - `f`      : 조건·정렬의 지문. 지금 요청의 지문과 다르면 거절한다 — 정렬이나 조건을
 *              바꾼 요청에 옛 커서를 이어 붙이면 행이 새거나 겹친다.
 * - `o`      : 이 커서 앞에 이미 내보낸 행 수. "51–100번째" 표시용이며 판정에는 안 쓴다.
 */
export interface CursorPayload {
  /** 커서 형식 버전. 형식을 바꾸면 올리고, 모르는 버전은 거부한다 */
  v: 2
  /** 정렬 기준 값. 정렬 기준이 비어 있는 행이면 null */
  s: string | number | null
  /** 마지막으로 내보낸 행의 id (동률 tie-break) */
  id: string
  /** 조건·정렬 지문 (queryFingerprint) */
  f: string
  /** 앞선 행 수 (0 이상 정수) */
  o: number
}

export const CURSOR_VERSION = 2 as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function encodeCursor(payload: Omit<CursorPayload, 'v'>): string {
  const full: CursorPayload = { v: CURSOR_VERSION, s: payload.s, id: payload.id, f: payload.f, o: payload.o }
  return base64UrlEncode(JSON.stringify(full))
}

/** 못 읽는 커서는 null. 남이 준 문자열이므로 여기서 throw 하면 안 된다 */
export function decodeCursor(raw: string | null | undefined): CursorPayload | null {
  if (!raw) return null
  if (raw.length > 2048) return null
  const json = base64UrlDecode(raw)
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (o['v'] !== CURSOR_VERSION) return null
  if (typeof o['id'] !== 'string' || !UUID_PATTERN.test(o['id'])) return null
  if (typeof o['f'] !== 'string' || o['f'] === '') return null
  const offset = o['o']
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null
  const s = o['s']
  if (s !== null && typeof s !== 'string' && typeof s !== 'number') return null
  if (typeof s === 'number' && !Number.isFinite(s)) return null
  return { v: CURSOR_VERSION, s, id: o['id'], f: o['f'], o: offset }
}

// ── 파싱 ─────────────────────────────────────────────────────────────────

function problem(message: string, param?: string): QueryProblem {
  return param === undefined ? { code: 'invalid_query', message } : { code: 'invalid_query', message, param }
}

function coerceComparable(
  field: FieldDef,
  raw: string,
): { ok: true; value: string | number } | { ok: false } {
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = normalizeNumberValue(raw)
      return n === null ? { ok: false } : { ok: true, value: n }
    }
    case 'date': {
      const d = normalizeDateValue(raw)
      return d === null ? { ok: false } : { ok: true, value: d }
    }
    case 'enum':
      return { ok: true, value: normalizeEnumValue(raw.trim(), field.mapping) }
    case 'text':
    case 'link':
      return { ok: true, value: raw.trim() }
  }
}

/** 값의 형식 안내 — "무엇을 대신 보내야 하는지" 까지가 문제 문장이다 */
function expectedFormat(field: FieldDef): string {
  switch (field.type) {
    case 'date':
      return 'YYYY-MM-DD 형식의 날짜'
    case 'money':
      return '원 단위 숫자'
    case 'number':
      return '숫자'
    default:
      return '글자'
  }
}

/**
 * URLSearchParams → 타입 안전한 CollectionQuery. 기획서 12장 표 전부.
 *
 * 검증 기준은 컬렉션 스키마(FieldDef[]) 다. 스키마에 없는 이름은 조건이 되지 않고 **문제**가 된다 —
 * 이 화이트리스트가 build.ts 의 SQL 안전성 근거이기도 하다.
 */
export function parseCollectionQuery(
  input: QueryParamsInput,
  fields: readonly FieldDef[],
): ParsedCollectionQuery {
  const search = toSearchParams(input)
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const problems: QueryProblem[] = []

  const eq: Record<string, string | number | boolean> = {}
  const gte: Record<string, string | number> = {}
  const lte: Record<string, string | number> = {}
  let q: string | undefined
  let source: string | undefined
  let since: string | undefined
  let sort: string | undefined
  let cursor: string | null = null
  let limit: number = DEFAULT_PAGE_LIMIT
  const include: 'provenance'[] = []

  const handled = new Set<string>()

  for (const name of search.keys()) {
    if (handled.has(name)) continue
    handled.add(name)

    const values = search.getAll(name)

    // `include` 만 값이 여러 개여도 말이 된다 (`?include=provenance,raw`)
    if (name === 'include') {
      for (const part of values.flatMap((v) => v.split(','))) {
        const token = part.trim()
        if (token === '') continue
        if (token === 'provenance') {
          if (!include.includes('provenance')) include.push('provenance')
        } else {
          problems.push(problem(`함께 담을 수 없는 항목입니다: ${token} (쓸 수 있는 값: provenance)`, 'include'))
        }
      }
      continue
    }

    // 같은 이름이 둘이면 어느 쪽을 뜻했는지 알 수 없다 — 하나를 골라 적용하지 않는다
    if (values.length > 1) {
      problems.push(problem(`같은 조건이 여러 번 왔습니다: ${name}. 하나만 보내 주세요`, name))
      continue
    }
    const raw = values[0] ?? ''

    // 빈 값은 "조건 없음"으로 본다. 폼에서 비워두고 보내는 경우가 흔하다 (머리말 원칙 3)
    if (raw.trim() === '') continue

    switch (name) {
      case 'q': {
        if (!fields.some((f) => f.type === 'text')) {
          problems.push(problem('이 컬렉션에는 글자로 된 칸이 없어 검색어를 쓸 수 없습니다', 'q'))
          continue
        }
        const term = raw.trim()
        if (term.length > 200) {
          problems.push(problem('검색어는 200자까지 쓸 수 있습니다', 'q'))
          continue
        }
        q = term
        continue
      }
      case 'source': {
        source = raw.trim()
        continue
      }
      case 'since': {
        const at = normalizeInstantValue(raw)
        if (at === null) {
          problems.push(problem(`날짜를 이해하지 못했습니다: since=${raw} (YYYY-MM-DD 또는 ISO 8601 시각)`, 'since'))
        } else {
          since = at
        }
        continue
      }
      case 'sort': {
        const spec = raw.trim()
        const key = spec.startsWith('-') ? spec.slice(1) : spec
        if (!SORT_PATTERN.test(spec) || !isSortableKey(key, fields)) {
          const allowed = [...fields.map((f) => f.key), ...BUILTIN_SORT_KEYS].join(', ')
          problems.push(problem(`정렬 기준으로 쓸 수 없습니다: ${spec} (쓸 수 있는 값: ${allowed})`, 'sort'))
          continue
        }
        sort = spec
        continue
      }
      case 'limit': {
        const n = normalizeNumberValue(raw)
        if (n === null || !Number.isInteger(n) || n < 1) {
          problems.push(problem(`개수는 1 이상의 정수여야 합니다: limit=${raw}`, 'limit'))
          continue
        }
        if (n > MAX_PAGE_LIMIT) {
          problems.push({
            code: 'limit_exceeded',
            message: `한 번에 가져올 수 있는 최대 개수는 ${MAX_PAGE_LIMIT}개입니다 (받은 값: ${n}). 더 필요하면 next_cursor 로 이어서 가져오세요`,
            param: 'limit',
          })
          continue
        }
        limit = n
        continue
      }
      case 'cursor': {
        const decoded = decodeCursor(raw.trim())
        if (decoded === null) {
          problems.push({
            code: 'invalid_cursor',
            message: '이어보기 정보(cursor)를 읽지 못했습니다. 직전 응답의 next_cursor 를 그대로 보내거나, 빼고 처음부터 요청하세요',
            param: 'cursor',
          })
          continue
        }
        cursor = raw.trim()
        continue
      }
      default:
        break
    }

    // 필드 완전일치가 먼저다. `x_gte` 라는 이름의 필드가 실제로 있을 수도 있다
    const exact = byKey.get(name)
    if (exact) {
      const coerced = coerceComparable(exact, raw)
      if (!coerced.ok) {
        problems.push(problem(`'${exact.label}' 값은 ${expectedFormat(exact)}여야 합니다: ${name}=${raw}`, name))
      } else {
        eq[name] = coerced.value
      }
      continue
    }

    const suffix = RANGE_SUFFIXES.find((s) => name.endsWith(s))
    if (suffix) {
      const base = name.slice(0, -suffix.length)
      const field = byKey.get(base)
      if (!field) {
        problems.push(problem(`이 컬렉션에 없는 조건입니다: ${name}`, name))
        continue
      }
      if (!RANGE_FIELD_TYPES.includes(field.type)) {
        problems.push(problem(`범위 조건은 날짜·금액·숫자 칸에만 쓸 수 있습니다: ${field.label} (${name})`, name))
        continue
      }
      const coerced = coerceComparable(field, raw)
      if (!coerced.ok) {
        problems.push(problem(`'${field.label}' 값은 ${expectedFormat(field)}여야 합니다: ${name}=${raw}`, name))
        continue
      }
      if (suffix === '_gte') gte[base] = coerced.value
      else lte[base] = coerced.value
      continue
    }

    problems.push(problem(`이 컬렉션에 없는 조건입니다: ${name}`, name))
  }

  if (problems.length > 0) return { ok: false, problems }

  const result = CollectionQuerySchema.safeParse({ eq, gte, lte, q, source, since, sort, limit, cursor, include })
  if (result.success) return { ok: true, query: result.data }

  // 위 검증에 구멍이 있다는 뜻이다. 넓은 결과를 내지 말고 실패로 돌려준다 (A46)
  return { ok: false, problems: [problem('조건을 이해하지 못했습니다')] }
}

/** 조건이 하나도 없는 기본 쿼리 (첫 페이지 · 기본 정렬 · 기본 개수) */
export function emptyCollectionQuery(): CollectionQuery {
  return CollectionQuerySchema.parse({})
}

/** 구독의 `filter_json` 처럼 페이지네이션을 뺀 조건만 필요할 때 (기획서 10장) */
export function toCollectionFilter(query: CollectionQuery): Omit<
  CollectionQuery,
  'limit' | 'cursor' | 'include'
> {
  const { limit: _limit, cursor: _cursor, include: _include, ...filter } = query
  return filter
}
