// 뷰(View) — "내가 계속 신경 쓰기로 한 것"의 정의 (뷰 계약 · 델타 2절)
//
// 계약의 정본은 docs/view-contract-draft.md 다 (07-27 저녁 확정 · G0 계약 #6).
// 여기를 고치는 것은 G0 계약을 고치는 것이다 — 양쪽 트랙이 같이 있을 때만.
//
// ── 술어(op)는 닫힌 집합이다 (A35 — 변환 연산자 A2 와 같은 규율) ─────────
// 목록 밖 op · 자유 표현식 · SQL 조각은 **파싱 단계에서** 거부한다. 뷰는 표·알림·REST·MCP
// 네 출구를 전부 타므로, 여기가 열리면 네 곳에서 안전을 보장해야 한다.
// 표현이 부족하면 임시방편을 끼우지 말고 **술어를 추가하라.**
//
// ── date 조건 값은 상대 표현만 저장한다 (A34·A35) ────────────────────────
// `2026-08-31` 같은 절대 날짜가 박힌 뷰는 기준일이 지나면 영원히 0건이 된다 —
// 화면의 0건은 "해당 없음"과 구별되지 않는 조용한 실패다. 절대 날짜는 조회 계층
// (REST 쿼리 파라미터 · 표 위 필터)의 몫이고, 저장 계층인 여기서는 스키마가 거부한다.

import { z } from 'zod'

import type { FieldDef, FieldType } from './collection'

// ── 건강 · 이벤트 ────────────────────────────────────────────────────────

/** 뷰 건강 (델타 2-8). **저장하지 않는다** — 읽을 때 계산한다 (계약 §7 결정 ③).
 *  값 키는 내부용 — 화면은 사람 문장으로 옮긴다 (B2) */
export const VIEW_HEALTH = ['ok', 'warn', 'broken'] as const
export type ViewHealth = (typeof VIEW_HEALTH)[number]

/** 알림 전이 (델타 2-5). v1 은 enter 만 — 재진입도 새 enter 다 (계약 §7 결정 ①) */
export const VIEW_EVENTS = ['enter'] as const
export type ViewEvent = (typeof VIEW_EVENTS)[number]

// ── 상대 시간 표현 (A34) ─────────────────────────────────────────────────

/** `within` 이 받는 달력 구간. KST 기준 (계약 §3 — 일일 평가는 KST 자정 직후) */
export const RELATIVE_DATE_RANGES = ['this_week', 'this_month'] as const
export type RelativeDateRange = (typeof RELATIVE_DATE_RANGES)[number]

/** `before`/`after` 가 받는 기준점. 부족하면 여기에 **추가**한다 — 절대 날짜를 열지 마라 */
export const RELATIVE_DATE_POINTS = ['today'] as const
export type RelativeDatePoint = (typeof RELATIVE_DATE_POINTS)[number]

// ── 조건 (술어 닫힌 집합 — 계약 §2) ──────────────────────────────────────

/** 한 뷰에 담을 수 있는 조건 수. 그 이상은 뷰가 아니라 프로그램이다 */
export const MAX_VIEW_CONDITIONS = 10

/** `in`/`not_in` 목록 상한 */
const MAX_ENUM_VALUES = 50

const fieldKey = z.string().min(1)

/**
 * op 마다 value 의 모양이 다르므로 discriminated union 으로 검증한다.
 * 여기 없는 op 는 파싱이 거부한다 — 이 목록이 곧 A35 의 닫힌 집합이다.
 */
export const ViewConditionSchema = z.discriminatedUnion('op', [
  // date — 상대 표현만. 절대 날짜(YYYY-MM-DD)는 enum 검증에서 자연히 거부된다
  z.object({ field: fieldKey, op: z.literal('within'), value: z.enum(RELATIVE_DATE_RANGES) }),
  z.object({ field: fieldKey, op: z.literal('d_within'), value: z.number().int().min(0).max(365) }),
  z.object({ field: fieldKey, op: z.literal('before'), value: z.enum(RELATIVE_DATE_POINTS) }),
  z.object({ field: fieldKey, op: z.literal('after'), value: z.enum(RELATIVE_DATE_POINTS) }),
  // 값 없음 판정 — `상시`(마감 없음) 같은 것. 마감 뷰의 기본은 제외다 (범위 비교가 null 을 자연히 거른다)
  z.object({ field: fieldKey, op: z.literal('is_null') }),
  // number / money
  z.object({ field: fieldKey, op: z.literal('gte'), value: z.number().finite() }),
  z.object({ field: fieldKey, op: z.literal('lte'), value: z.number().finite() }),
  z.object({
    field: fieldKey,
    op: z.literal('between'),
    value: z.tuple([z.number().finite(), z.number().finite()]),
  }),
  // enum — 정규화 키 기준
  z.object({ field: fieldKey, op: z.literal('in'), value: z.array(z.string().min(1)).min(1).max(MAX_ENUM_VALUES) }),
  z.object({
    field: fieldKey,
    op: z.literal('not_in'),
    value: z.array(z.string().min(1)).min(1).max(MAX_ENUM_VALUES),
  }),
  // text
  z.object({ field: fieldKey, op: z.literal('contains'), value: z.string().min(1).max(200) }),
  z.object({ field: fieldKey, op: z.literal('not_contains'), value: z.string().min(1).max(200) }),
])

export type ViewCondition = z.infer<typeof ViewConditionSchema>
export type ViewOp = ViewCondition['op']

/** 필드 타입별로 허용되는 술어. 이 표 밖의 조합은 validateViewWhere 가 거부한다 */
export const VIEW_OPS_BY_FIELD_TYPE: Record<FieldType, readonly ViewOp[]> = {
  date: ['within', 'd_within', 'before', 'after', 'is_null'],
  number: ['gte', 'lte', 'between', 'is_null'],
  money: ['gte', 'lte', 'between', 'is_null'],
  enum: ['in', 'not_in'],
  text: ['contains', 'not_contains'],
  // 링크에 거는 조건은 말이 되는 게 없다. 필요해지면 술어를 추가한다
  link: [],
}

// ── 뷰 본체 ──────────────────────────────────────────────────────────────

/** 컬렉션당 뷰 상한 (델타 2-9 — 성능이 아니라 신호). **서버가 거부한다** (계약 §5) */
export const MAX_VIEWS_PER_COLLECTION = 20

export const ViewSortSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']),
})
export type ViewSort = z.infer<typeof ViewSortSchema>

/**
 * 뷰 알림은 **켬/끔뿐이다** — 어디로 보낼지는 뷰가 아니라 컬렉션이 정한다.
 * 받을 주소는 subscriptions 행(컬렉션 단위)이고, `enabled` 체크가 켜진 주소 전부로 나간다.
 * (07-30 개편 — 예전의 뷰별 channels 목록은 파싱 시 자연히 버려진다: zod 가 모르는 키를 벗긴다)
 */
export const ViewNotifySchema = z.object({
  on: z.enum(VIEW_EVENTS),
})
export type ViewNotify = z.infer<typeof ViewNotifySchema>

/** 표시 설정에서 출처 열을 가리키는 id — 스키마 칸이 아니지만 열로 보인다 */
export const SOURCE_COLUMN_ID = '_source'

/** 검색어 상한 — REST `?q=` 와 같다 (params.ts) */
export const MAX_SEARCH_LENGTH = 200

/**
 * 저장되는 뷰 정의 (views 테이블의 jsonb 들 + 메타).
 * **health 는 여기 없다** — 읽을 때 계산해 응답에만 싣는다 (계약 §7 결정 ③).
 *
 * 두 층이다 (ADR A47):
 *  - **조회 상태** `where` · `sort`(첫 항목) · `q` · `source` — 웹·REST·MCP 가 같은 뜻으로 적용한다
 *  - **표시 설정** `columns` — 보일 열과 순서. 웹에서만 복원하고 조회 결과는 바꾸지 않는다
 * `q`·`source` 는 A47 에서 더했다. 예전에 저장된 뷰는 없음(null) = 조건 없음이라 그대로 호환된다.
 */
export const ViewDefinitionSchema = z.object({
  name: z.string().min(1).max(60),
  where: z.array(ViewConditionSchema).max(MAX_VIEW_CONDITIONS).default([]),
  sort: z.array(ViewSortSchema).max(3).default([]),
  /** 글자 칸 전체 대상 검색어. null = 없음 */
  q: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).nullable().default(null),
  /** 출처 호스트. null = 모든 출처 */
  source: z.string().trim().min(1).max(253).nullable().default(null),
  /** 보일 열과 순서 (`_source` 포함 가능). null = 컬렉션 기본 열 */
  columns: z.array(z.string().min(1)).min(1).nullable().default(null),
  /** null = 알림 꺼짐 (기본) */
  notify: ViewNotifySchema.nullable().default(null),
  pinned: z.boolean().default(false),
})
export type ViewDefinition = z.infer<typeof ViewDefinitionSchema>

/**
 * 뷰의 조회 상태 — 표의 임시 조건(URL)과 저장된 뷰가 **같은 모양**이다.
 * 그래서 "지금 보는 것" 을 그대로 저장하고, 저장된 것을 그대로 다시 본다.
 */
export interface ViewQueryState {
  where: ViewCondition[]
  sort: ViewSort[]
  q: string | null
  source: string | null
}

// ── 검증 — 스키마(FieldDef[]) 대조 (A35 의 "파싱 단계에서 거부") ─────────

export interface ViewValidation {
  ok: boolean
  /** 화면에 그대로 나갈 수 있는 문장들 (B2 — 내부 명사 없음) */
  errors: string[]
}

/**
 * **조회 상태**가 실제 스키마(그리고 주면 출처 목록)와 맞는지 본다. zod(모양) 다음의 두 번째 겹이다.
 * 여기서 통과한 필드 키만 SQL 근처로 간다 — build.ts 의 화이트리스트 근거와 같은 원리.
 *
 * 표시 설정(`columns`)은 여기서 보지 않는다 (A47) — 사라진 열은 `pruneViewColumns` 가 걸러낼 뿐
 * 뷰를 깨뜨리지 않는다. 표시 문제로 REST·MCP 조회까지 멈추면 안 된다.
 *
 * @param hosts 컬렉션의 출처 호스트들. 주면 저장된 출처가 아직 있는지까지 본다
 */
export function validateViewDefinition(
  def: Pick<ViewDefinition, 'where' | 'sort'> & Partial<Pick<ViewDefinition, 'q' | 'source'>>,
  fields: readonly FieldDef[],
  hosts?: readonly string[],
): ViewValidation {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const errors: string[] = []

  const seen = new Set<string>()
  for (const cond of def.where) {
    const field = byKey.get(cond.field)
    if (field === undefined) {
      errors.push(`'${cond.field}' 라는 칸이 이 표에 없어요.`)
      continue
    }
    if (!VIEW_OPS_BY_FIELD_TYPE[field.type].includes(cond.op)) {
      errors.push(`'${field.label}' 칸에는 쓸 수 없는 조건이에요.`)
      continue
    }
    // 같은 칸에 같은 종류 조건이 두 번이면 무엇을 의도했는지 알 수 없다 — 합치지 말고 거부한다
    const dupKey = `${cond.field}:${cond.op}`
    if (seen.has(dupKey)) {
      errors.push(`'${field.label}' 칸에 같은 종류의 조건이 두 번 있어요. 하나로 합쳐 주세요.`)
      continue
    }
    seen.add(dupKey)

    if (cond.op === 'between' && cond.value[0] > cond.value[1]) {
      errors.push(`'${field.label}' 범위의 시작이 끝보다 커요.`)
    }
  }

  for (const s of def.sort) {
    if (!byKey.has(s.field) && !BUILTIN_VIEW_SORT_KEYS.includes(s.field)) {
      errors.push(`정렬 기준 '${s.field}' 이(가) 이 표에 없어요.`)
    }
  }

  if (def.q !== undefined && def.q !== null && !fields.some((f) => f.type === 'text')) {
    errors.push('검색어가 저장돼 있는데 이 표에 글자 칸이 없어요.')
  }

  if (def.source !== undefined && def.source !== null && hosts !== undefined) {
    const norm = (h: string) => h.trim().toLowerCase().replace(/^www\./, '')
    if (!hosts.some((h) => norm(h) === norm(def.source as string))) {
      errors.push(`저장된 출처 '${def.source}' 가 이 컬렉션에 더 이상 없어요.`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/** 정렬에 쓸 수 있는 스키마 밖 키 — query/params.ts 의 BUILTIN_SORT_KEYS 와 같다 */
const BUILTIN_VIEW_SORT_KEYS: readonly string[] = ['first_seen_at', 'last_seen_at']

/**
 * 표시 설정의 열 목록에서 지금 없는 열을 걸러낸다 (A47 — 뷰를 깨뜨리지 않는다).
 * 남는 게 없으면 null(=기본 열)로 돌아간다.
 */
export function pruneViewColumns(
  columns: readonly string[] | null,
  fields: readonly FieldDef[],
): { columns: string[] | null; dropped: string[] } {
  if (columns === null) return { columns: null, dropped: [] }
  const known = new Set([SOURCE_COLUMN_ID, ...fields.map((f) => f.key)])
  const kept: string[] = []
  const dropped: string[] = []
  for (const c of columns) {
    if (known.has(c) && !kept.includes(c)) kept.push(c)
    else if (!known.has(c)) dropped.push(c)
  }
  return { columns: kept.length === 0 ? null : kept, dropped }
}

// ── 사람 문장 요약 (B2 — 내부 표현을 화면·도구 설명에 내보내지 않는다) ────
// 화면(작업실 카드·이름 자동 제안)과 MCP(뷰별 도구 설명)가 같이 쓴다.
// 두 표면이 각자 요약을 짜면 "표에서 보이는 조건과 도구 설명이 다르다"가 된다.

const summaryNumber = new Intl.NumberFormat('ko-KR')

function summaryLabelOf(fields: readonly FieldDef[], key: string): string {
  return fields.find((f) => f.key === key)?.label ?? key
}

function summaryEnumLabelOf(fields: readonly FieldDef[], key: string, value: string): string {
  return fields.find((f) => f.key === key)?.value_labels?.[value] ?? value
}

/** 조건 하나 → 사람 문장 조각 */
export function summarizeViewCondition(cond: ViewCondition, fields: readonly FieldDef[]): string {
  const label = summaryLabelOf(fields, cond.field)
  switch (cond.op) {
    case 'within':
      return cond.value === 'this_week' ? `이번 주 ${label}` : `이번 달 ${label}`
    case 'd_within':
      return `${label} D-${cond.value} 이내`
    case 'before':
      return `지난 ${label}`
    case 'after':
      return `다가올 ${label}`
    case 'is_null':
      return `${label} 없음`
    case 'gte':
      return `${label} ${summaryNumber.format(cond.value)} 이상`
    case 'lte':
      return `${label} ${summaryNumber.format(cond.value)} 이하`
    case 'between':
      return `${label} ${summaryNumber.format(cond.value[0])}~${summaryNumber.format(cond.value[1])}`
    case 'in':
      return `${label}: ${cond.value.map((v) => summaryEnumLabelOf(fields, cond.field, v)).join('/')}`
    case 'not_in':
      return `${label} 제외: ${cond.value.map((v) => summaryEnumLabelOf(fields, cond.field, v)).join('/')}`
    case 'contains':
      return `‘${cond.value}’ 포함`
    case 'not_contains':
      return `‘${cond.value}’ 제외`
  }
}

export function summarizeViewConditions(
  conds: readonly ViewCondition[],
  fields: readonly FieldDef[],
): string {
  return conds.map((c) => summarizeViewCondition(c, fields)).join(' · ')
}

/**
 * 조회 상태 전체(칸 조건 + 검색어 + 출처 + 정렬) → 사람 문장.
 * 화면 카드·MCP 도구 설명이 같이 쓴다 — 검색어·출처를 빼고 요약하면 도구 설명이 실제 조건보다 넓어 보인다.
 */
export function summarizeViewState(
  state: Pick<ViewQueryState, 'where' | 'q' | 'source'> & { sort?: readonly ViewSort[] },
  fields: readonly FieldDef[],
): string {
  const parts: string[] = []
  const conds = summarizeViewConditions(state.where, fields)
  if (conds !== '') parts.push(conds)
  if (state.q !== null && state.q !== '') parts.push(`검색어 ‘${state.q}’`)
  if (state.source !== null && state.source !== '') parts.push(`출처 ${state.source}`)
  const first = state.sort?.[0]
  if (first !== undefined) {
    const label =
      first.field === 'first_seen_at'
        ? '처음 올라온 때'
        : first.field === 'last_seen_at'
          ? '마지막으로 본 때'
          : summaryLabelOf(fields, first.field)
    parts.push(`${label} ${first.dir === 'asc' ? '오름차순' : '내림차순'}`)
  }
  return parts.join(' · ')
}

// ── slug ─────────────────────────────────────────────────────────────────

/**
 * 뷰 이름 → slug 후보. **MCP 도구명의 ASCII 제약이 이 규칙의 이유다** (계약 §1 ※).
 * 한국어 이름("이번 달 마감")처럼 라틴 문자가 안 남으면 null — 호출자가 `view-N` 순번을 쓴다.
 * 한국어 이름은 MCP 도구 설명에 들어간다.
 */
export function suggestViewSlug(name: string): string | null {
  const latin = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  const alnum = latin.replace(/-/g, '')
  if (alnum.length < 2 || latin.length > 40) return null
  return latin
}
