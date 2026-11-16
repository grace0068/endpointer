// CollectionQuery → Drizzle where / orderBy / 커서 조건
//
// ── SQL 안전성에 대해 (읽고 넘어가라) ──────────────────────────────────
// items.data_json 은 JSONB 다. 필드 조건은 `data_json ->> 'key'` 로 꺼내 비교한다.
// 여기 들어오는 **필드 키는 전부 컬렉션 스키마(FieldDef[])에 있는 것뿐이다** —
// params.ts 가 스키마에 없는 이름을 애초에 버리고(화이트리스트), build 단계에서도
// 넘겨받은 fields 로 한 번 더 확인한다. 그리고 키든 값이든 SQL 문자열에 이어붙이지 않고
// 전부 drizzle 의 sql 템플릿 파라미터 바인딩($1, $2 …)으로 나간다.
// 즉 화이트리스트와 바인딩 두 겹이라 SQL 인젝션 경로가 없다.
// 이 파일에 문자열 연결로 SQL 을 만드는 코드를 추가하지 마라. 그 순간 이 문단이 거짓이 된다.
//
// ── 타입별 비교 방식 ──────────────────────────────────────────────────
// - date  : 정규화가 `YYYY-MM-DD` 를 보장하므로 **문자열 비교**로 충분하다 (사전순 = 시간순).
//           ::date 캐스팅을 쓰면 값 하나가 지저분할 때 쿼리 전체가 죽는다. 원칙 ④에 반한다.
// - money/number : 숫자 캐스팅이 필요하다. 다만 숫자꼴이 아닌 값은 NULL 로 떨어뜨리고 넘어간다
//           (정규 표현식 가드). 역시 한 행 때문에 컬렉션 전체가 죽지 않게.
// - text/enum/link : 텍스트 그대로.

import { and, sql, type SQL } from 'drizzle-orm'

import { items } from '../db/schema'
import { hashString, stableStringify } from '../spec/interpret'
import type { CollectionQuery } from '../types/api'
import type { FieldDef } from '../types/collection'
import {
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_SPEC,
  decodeCursor,
  isBuiltinSortKey,
  toCollectionFilter,
  type BuiltinSortKey,
  type CursorPayload,
} from './params'

export type SortDirection = 'asc' | 'desc'

/** 숫자로 읽을 수 있는 값만 통과시키는 가드. 나머지는 NULL 이 되어 정렬 맨 뒤로 간다 */
const NUMERIC_GUARD = '^-?[0-9]+(\\.[0-9]+)?$'
/** 같은 가드의 JS 판 — 커서에 싣는 정렬값이 SQL 식과 **같은 규칙**으로 뽑혀야 한다 (sortValueOf) */
const NUMERIC_GUARD_RE = new RegExp(NUMERIC_GUARD)

/**
 * data_json 의 한 항목을 비교 가능한 SQL 식으로 만든다.
 * 키는 파라미터로 바인딩된다 — 위 "SQL 안전성" 문단 참조.
 */
export function fieldExpr(field: FieldDef): SQL {
  switch (field.type) {
    case 'number':
    case 'money':
      return sql`(case when ${items.data_json} ->> ${field.key} ~ ${NUMERIC_GUARD}
                  then (${items.data_json} ->> ${field.key})::numeric end)`
    default:
      // date 포함. 정규화된 YYYY-MM-DD 는 사전순 비교가 곧 시간순 비교다
      return sql`(${items.data_json} ->> ${field.key})`
  }
}

/** 비교 대상 값을 타입에 맞게 바인딩한다. 캐스팅을 명시해 서버 쪽 추론에 기대지 않는다 */
function bindValue(field: FieldDef, value: string | number): SQL {
  switch (field.type) {
    case 'number':
    case 'money':
      return sql`${Number(value)}::numeric`
    default:
      return sql`${String(value)}::text`
  }
}

/** LIKE 메타문자를 사용자 입력에서 죽인다 (기본 이스케이프 문자는 백슬래시) */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ── 정렬 ─────────────────────────────────────────────────────────────────

export interface ResolvedSort {
  /** 정렬 기준 이름. 스키마 필드 키이거나 first_seen_at / last_seen_at */
  key: string
  direction: SortDirection
  kind: 'field' | 'builtin'
  /** 비교·정렬에 쓰는 SQL 식 */
  expr: SQL
  /** 값이 비어 있을 수 있는가. data_json 항목은 언제나 비어 있을 수 있다 */
  nullable: boolean
  /** kind === 'field' 일 때만 */
  field: FieldDef | null
}

function builtinColumn(key: BuiltinSortKey) {
  return key === 'last_seen_at' ? items.last_seen_at : items.first_seen_at
}

/**
 * 시각 정렬 식 — **밀리초로 자른다** (ADR A46).
 *
 * timestamptz 는 마이크로초까지 담는데 커서는 JS Date(밀리초)로 실린다. 한 번의 수집이
 * 한 트랜잭션의 `now()` 로 항목 수십 개를 같은 마이크로초에 넣으므로, 자르지 않으면
 * 커서 값(.123)과 실제 값(.123456)이 영영 같아지지 않는다 — 동률 구간이 통째로 다음 페이지에서
 * 빠진다. 정렬과 비교를 둘 다 같은 식으로 하면 동률은 id 로 깨지고 경계가 맞는다.
 */
function builtinExpr(key: BuiltinSortKey): SQL {
  return sql`date_trunc('milliseconds', ${builtinColumn(key)})`
}

/**
 * `?sort=deadline` / `?sort=-amount` 를 푼다.
 * 스키마에 없는 기준은 기본값으로 떨어진다 (params.ts 가 이미 경고를 남겼다).
 */
export function resolveSort(
  sort: string | undefined,
  fields: readonly FieldDef[],
): ResolvedSort {
  const fallback = (): ResolvedSort => ({
    key: DEFAULT_SORT_KEY,
    direction: DEFAULT_SORT_DIRECTION,
    kind: 'builtin',
    expr: builtinExpr(DEFAULT_SORT_KEY),
    nullable: false,
    field: null,
  })

  if (!sort) return fallback()

  const direction: SortDirection = sort.startsWith('-') ? 'desc' : 'asc'
  const key = sort.startsWith('-') ? sort.slice(1) : sort

  if (isBuiltinSortKey(key)) {
    return {
      key,
      direction,
      kind: 'builtin',
      expr: builtinExpr(key),
      nullable: false,
      field: null,
    }
  }

  const field = fields.find((f) => f.key === key)
  if (!field) return fallback()

  return { key, direction, kind: 'field', expr: fieldExpr(field), nullable: true, field }
}

/**
 * 안정 정렬. 정렬값이 같은 행들 사이 순서가 매번 달라지면 커서 페이지네이션이 무너지므로
 * 항상 id 를 마지막 기준으로 붙인다. NULL 은 어느 방향이든 맨 뒤 (NULLS LAST).
 */
export function buildOrderBy(sort: ResolvedSort): SQL[] {
  const primary =
    sort.direction === 'asc'
      ? sql`${sort.expr} asc nulls last`
      : sql`${sort.expr} desc nulls last`
  return [primary, sql`${items.id} asc`]
}

/**
 * 커서에 실을 값을 행에서 뽑는다. **SQL 정렬식과 같은 값이어야 한다** —
 * 다르면 다음 페이지 조건이 엉뚱한 구간을 집어 행이 새거나 겹친다.
 *
 *  - 시각   : 밀리초 ISO (builtinExpr 가 밀리초로 자른다)
 *  - 숫자 칸 : 숫자이거나 숫자꼴 문자열만 값, 나머지는 null (NUMERIC_GUARD 와 같은 규칙)
 *  - 그 밖  : `->>` 가 내는 글자 그대로 — 숫자·불리언도 글자로 바뀐다
 */
export function sortValueOf(
  row: { id: string; data_json: Record<string, unknown>; first_seen_at: Date; last_seen_at: Date },
  sort: ResolvedSort,
): string | number | null {
  if (sort.kind === 'builtin') {
    const at = sort.key === 'last_seen_at' ? row.last_seen_at : row.first_seen_at
    return at.toISOString()
  }
  const v = row.data_json[sort.key]
  if (v === null || v === undefined) return null

  const type = sort.field?.type
  if (type === 'number' || type === 'money') {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string' && NUMERIC_GUARD_RE.test(v)) return Number(v)
    return null
  }
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/**
 * 조건·정렬의 지문 — 커서가 "어떤 요청의 이어보기인가" 를 기억하는 수단 (A46).
 * 페이지 크기·커서·include 는 결과 집합을 바꾸지 않으므로 빼고, 정렬은 기본값까지 풀어서 넣는다
 * (`sort` 를 안 준 요청과 `sort=-first_seen_at` 요청은 같은 집합·같은 순서다).
 * 보안 장치가 아니다 — 지문을 위조해도 where 는 언제나 지금 요청의 조건으로 만들어진다.
 */
export function queryFingerprint(query: CollectionQuery): string {
  const filter = toCollectionFilter(query)
  return hashString(stableStringify({ ...filter, sort: filter.sort ?? DEFAULT_SORT_SPEC }))
}

function bindSortValue(sort: ResolvedSort, value: string | number): SQL | null {
  if (sort.kind === 'builtin') {
    const at = new Date(String(value))
    if (Number.isNaN(at.getTime())) return null
    return sql`${at.toISOString()}::timestamptz`
  }
  if (!sort.field) return null
  if (sort.field.type === 'number' || sort.field.type === 'money') {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    return sql`${n}::numeric`
  }
  return sql`${String(value)}::text`
}

/**
 * `(정렬값, id)` 복합 커서 조건. NULLS LAST 정렬과 짝이 맞아야 한다:
 * 정렬값이 있는 구간을 다 지나면 NULL 구간이 오므로, 커서가 값 구간에 있을 때는
 * "값 구간의 뒤쪽" 과 "NULL 구간 전체" 가 모두 다음 페이지다.
 * 못 읽는 커서면 null 을 돌려 처음부터 보여준다 (throw 하지 않는다).
 */
export function buildCursorWhere(sort: ResolvedSort, cursor: CursorPayload): SQL | null {
  const idAfter = sql`${items.id} > ${cursor.id}::uuid`

  if (cursor.s === null) {
    if (!sort.nullable) {
      // 값이 비지 않는 기준인데 커서에 값이 없다 — 커서가 깨진 것으로 본다
      return null
    }
    // 이미 NULL 구간에 들어와 있다. 그 안에서는 id 로만 이어간다
    return sql`(${sort.expr} is null and ${idAfter})`
  }

  const bound = bindSortValue(sort, cursor.s)
  if (bound === null) return null

  const ahead = sort.direction === 'asc' ? sql`${sort.expr} > ${bound}` : sql`${sort.expr} < ${bound}`
  const tie = sql`(${sort.expr} = ${bound} and ${idAfter})`

  return sort.nullable
    ? sql`(${ahead} or ${tie} or ${sort.expr} is null)`
    : sql`(${ahead} or ${tie})`
}

// ── where ────────────────────────────────────────────────────────────────

export interface BuildWhereContext {
  collectionId: string
  fields: readonly FieldDef[]
  /**
   * `?source=` 를 실제 소스 id 로 푼 결과.
   * null 이면 출처 조건 없음, 빈 배열이면 "그런 출처가 없다" → 결과 0건.
   */
  sourceIds?: readonly string[] | null
}

function allOf(conditions: SQL[]): SQL {
  // collection_id 조건이 항상 들어가므로 비어 있을 수 없다
  return and(...conditions) ?? sql`true`
}

/**
 * `?q=` — text 타입 필드들을 이어붙여 ILIKE.
 *
 * ADR A6 대로 별도 검색엔진을 두지 않는다. items.data_json 의 GIN 인덱스(jsonb_ops)는
 * 완전일치·포함 질의는 태우지만 부분 문자열 검색은 못 태운다. 5일 규모(수천 행)에서
 * 부분 문자열은 순차 스캔으로 충분하고, 느려지면 pg_trgm 확장 + 표현식 GIN 인덱스를
 * 뒤에 붙이면 된다 — 그때도 이 ILIKE 식이 그대로 인덱스를 탄다. 지금 확장을 켜서
 * 마이그레이션을 복잡하게 만들 이유가 없다.
 */
function searchCondition(term: string, fields: readonly FieldDef[]): SQL | null {
  const textKeys = fields.filter((f) => f.type === 'text').map((f) => f.key)
  if (textKeys.length === 0) return null
  const parts = textKeys.map((k) => sql`coalesce(${items.data_json} ->> ${k}, '')`)
  const haystack = sql.join(parts, sql` || ' ' || `)
  return sql`(${haystack}) ilike ${`%${escapeLikePattern(term)}%`}`
}

/**
 * 완전일치는 JSONB 포함 연산자(`@>`)로 건다. 이쪽은 items_data_json_gin_idx 를 그대로 탄다.
 * 값은 JS 에서 객체를 만들어 통째로 바인딩하므로 키/값이 SQL 문법에 닿지 않는다.
 */
function equalityCondition(field: FieldDef, value: string | number | boolean): SQL {
  const probe = JSON.stringify({ [field.key]: value })
  return sql`${items.data_json} @> ${probe}::jsonb`
}

/** CollectionQuery → items 조회 where. 페이지 커서는 따로 붙인다 (buildCursorWhere) */
export function buildItemsWhere(query: CollectionQuery, ctx: BuildWhereContext): SQL {
  const byKey = new Map(ctx.fields.map((f) => [f.key, f]))
  const conditions: SQL[] = [sql`${items.collection_id} = ${ctx.collectionId}::uuid`]

  if (ctx.sourceIds !== undefined && ctx.sourceIds !== null) {
    if (ctx.sourceIds.length === 0) {
      conditions.push(sql`false`)
    } else {
      const list = sql.join(
        ctx.sourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )
      conditions.push(sql`${items.source_id} in (${list})`)
    }
  }

  for (const [key, value] of Object.entries(query.eq)) {
    const field = byKey.get(key)
    if (!field) continue // 스키마에 없는 키는 여기까지 오면 안 되지만 두 겹으로 막는다
    conditions.push(equalityCondition(field, value))
  }

  for (const [key, value] of Object.entries(query.gte)) {
    const field = byKey.get(key)
    if (!field) continue
    conditions.push(sql`${fieldExpr(field)} >= ${bindValue(field, value)}`)
  }

  for (const [key, value] of Object.entries(query.lte)) {
    const field = byKey.get(key)
    if (!field) continue
    conditions.push(sql`${fieldExpr(field)} <= ${bindValue(field, value)}`)
  }

  // ── 뷰 술어 (A33·A35) — 전부 화이트리스트 + 바인딩. 머리말의 안전성 문단이 그대로 적용된다
  for (const [key, values] of Object.entries(query.in)) {
    const field = byKey.get(key)
    if (!field || values.length === 0) continue
    // 완전일치의 OR — 각각이 GIN 인덱스를 타는 @> 다
    const anyOf = values.map((v) => equalityCondition(field, v))
    conditions.push(sql`(${sql.join(anyOf, sql` or `)})`)
  }

  for (const [key, values] of Object.entries(query.not_in)) {
    const field = byKey.get(key)
    if (!field || values.length === 0) continue
    // 값이 비어 있는 행은 "목록에 없음"이 맞으므로 포함된다 (@> 가 false → not → true)
    const anyOf = values.map((v) => equalityCondition(field, v))
    conditions.push(sql`not (${sql.join(anyOf, sql` or `)})`)
  }

  for (const [key, term] of Object.entries(query.contains)) {
    const field = byKey.get(key)
    if (!field) continue
    // 값이 비어 있는 행은 아무것도 포함하지 않는다 — null ilike → null → 제외 (coalesce 없이)
    conditions.push(sql`(${items.data_json} ->> ${field.key}) ilike ${`%${escapeLikePattern(term)}%`}`)
  }

  for (const [key, term] of Object.entries(query.not_contains)) {
    const field = byKey.get(key)
    if (!field) continue
    // 값이 비어 있는 행은 "포함하지 않음"이 맞으므로 coalesce 로 포함시킨다
    conditions.push(
      sql`coalesce(${items.data_json} ->> ${field.key}, '') not ilike ${`%${escapeLikePattern(term)}%`}`,
    )
  }

  for (const key of query.is_null) {
    const field = byKey.get(key)
    if (!field) continue
    // 키 없음 · json null · 빈 문자열 셋 다 "비어 있음"이다 (`상시` 가 이 셋 중 무엇으로 저장돼도)
    conditions.push(sql`nullif(${items.data_json} ->> ${field.key}, '') is null`)
  }

  if (query.q) {
    const search = searchCondition(query.q, ctx.fields)
    // 글자 칸이 없는데 검색어가 왔다 — 파싱·뷰 진단이 먼저 거른다. 그래도 여기까지 오면
    // 검색어를 버려 **더 넓은** 결과를 내지 말고, 아무것도 안 맞는 쪽으로 닫는다 (A46)
    conditions.push(search ?? sql`false`)
  }

  if (query.since) {
    conditions.push(sql`${items.first_seen_at} >= ${query.since}::timestamptz`)
  }

  return allOf(conditions)
}

/** 조회 한 번에 필요한 것들을 한 덩어리로. respond.ts 가 이것을 그대로 쓴다 */
export interface ItemsQueryPlan {
  where: SQL
  /** 커서까지 얹은 where. 첫 페이지면 where 와 같다 */
  pageWhere: SQL
  orderBy: SQL[]
  sort: ResolvedSort
  /** 다음 페이지 존재 여부를 알아내려고 하나 더 읽는다 */
  fetchLimit: number
  limit: number
  /** 이 페이지의 첫 행이 전체에서 몇 번째인가 (0부터) — 커서가 실어 나른다 */
  offset: number
  /** 다음 커서에 실을 지문 */
  fingerprint: string
}

/**
 * 커서는 **이미 검증된 것**이어야 한다 (resolve.ts 가 지문까지 본다).
 * 여기서 못 읽는 커서를 만나면 첫 페이지로 떨어지지 않고 던진다 — 조용히 처음부터
 * 다시 주면 클라이언트는 같은 행을 두 번 받는다.
 */
export function planItemsQuery(query: CollectionQuery, ctx: BuildWhereContext): ItemsQueryPlan {
  const where = buildItemsWhere(query, ctx)
  const sort = resolveSort(query.sort, ctx.fields)
  const cursor = decodeCursor(query.cursor)
  if (query.cursor !== null && cursor === null) {
    throw new Error('검증되지 않은 커서가 조회까지 왔습니다')
  }
  const cursorWhere = cursor ? buildCursorWhere(sort, cursor) : null
  if (cursor !== null && cursorWhere === null) {
    throw new Error('커서가 정렬 기준과 맞지 않습니다')
  }
  return {
    where,
    pageWhere: cursorWhere ? allOf([where, cursorWhere]) : where,
    orderBy: buildOrderBy(sort),
    sort,
    fetchLimit: query.limit + 1,
    limit: query.limit,
    offset: cursor?.o ?? 0,
    fingerprint: queryFingerprint(query),
  }
}
