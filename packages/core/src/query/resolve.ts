// 조회 요청 해석·실행 — 표 · REST · MCP 가 지나가는 **하나의 문** (ADR A46·A47)
//
//   [저장된 뷰 or 표의 지금 조건] ─stateToQuery─┐
//                                              ├─ AND 로 얹기 ─ 커서 지문 확인 ─ 조회
//   [요청 파라미터] ──────parseCollectionQuery─┘
//
// 이 파일이 지키는 것 셋:
//  1. **같은 입력이면 같은 판단.** REST 라우트·MCP 도구·웹 표가 전부 runCollectionRequest 를 부른다.
//     어느 표면이 어떤 조건을 받을지·어떤 오류를 낼지를 표면마다 다시 짜지 않는다.
//  2. **뷰를 넓히지 않는다.** 요청 조건은 뷰 위에 AND 로만 얹는다(뷰 계약 §4 의 "덮어쓰기" 를 대체).
//     하나뿐인 조건(검색어·출처·같은 칸 완전일치)이 뷰와 다르면 둘 중 하나를 고르지 않고 거절한다.
//  3. **적용할 수 없으면 실패한다.** 없는 뷰·깨진 뷰·다른 요청의 커서를 만나면 조건을 빼고
//     더 넓은 결과를 내는 대신 이유를 담아 실패를 돌려준다.

import { and, asc, desc, eq } from 'drizzle-orm'

import type { Db } from '../db/client'
import { views } from '../db/schema'
import type {
  ApiErrorCode,
  CollectionQuery,
  CollectionResponse,
  QueryProblem,
} from '../types/api'
import { primaryProblemCode } from '../types/api'
import type { FieldDef } from '../types/collection'
import {
  ViewDefinitionSchema,
  pruneViewColumns,
  validateViewDefinition,
  type ViewDefinition,
  type ViewHealth,
  type ViewNotify,
  type ViewQueryState,
} from '../types/view'
import { buildCursorWhere, queryFingerprint, resolveSort } from './build'
import { decodeCursor, parseCollectionQuery, type QueryParamsInput } from './params'
import {
  buildCollectionResponse,
  hostMatches,
  loadSourceStates,
  type CollectionLike,
  type SourceStateLike,
} from './respond'
import { viewToQuery } from './view'

// ── 저장된 뷰 읽기 (순수 판정 + DB 조회) ─────────────────────────────────

/** views 테이블의 한 행 — DB 에서 읽은 그대로 (jsonb 는 unknown) */
export interface StoredViewRow {
  id: string
  slug: string
  name: string
  where_json: unknown
  sort_json: unknown
  search_q: string | null
  source_host: string | null
  columns_json: unknown
  notify_json: unknown
  pinned: boolean
  created_at: Date | null
}

/** 읽어서 판정까지 마친 뷰. 화면·REST·MCP 가 같은 판정을 본다 */
export interface StoredView {
  id: string
  slug: string
  name: string
  /** 조회 상태 — 깨진 뷰면 읽을 수 있는 만큼만 (화면이 "고쳐서 다시 저장" 에 쓴다) */
  state: ViewQueryState
  /** 표시 설정 — 지금 없는 열은 걸러진 상태 */
  columns: string[] | null
  /** 표시 설정에서 걸러낸 열 (화면이 "사라진 열" 로 알린다. 뷰는 안 깨진다) */
  droppedColumns: string[]
  notify: ViewNotify | null
  pinned: boolean
  created_at: Date | null
  /** 조회 상태가 스키마·출처와 맞으면 ok, 아니면 broken (A47) */
  health: ViewHealth
  /** broken 인 이유 — 사람이 읽는 문장 */
  problems: string[]
}

/**
 * 행 → StoredView. **순수 함수** (DB 없이 테스트된다).
 * 모양이 깨졌거나 스키마·출처와 안 맞으면 health 를 낮춘다 — 조용히 무시하지 않는다.
 */
export function parseStoredView(
  row: StoredViewRow,
  fields: readonly FieldDef[],
  hosts?: readonly string[],
): StoredView {
  const parsed = ViewDefinitionSchema.safeParse({
    name: row.name,
    where: row.where_json ?? [],
    sort: row.sort_json ?? [],
    q: row.search_q,
    source: row.source_host,
    columns: row.columns_json ?? null,
    notify: row.notify_json ?? null,
    pinned: row.pinned,
  })

  const base = {
    id: row.id,
    slug: row.slug,
    pinned: row.pinned,
    created_at: row.created_at,
  }

  if (!parsed.success) {
    return {
      ...base,
      name: row.name,
      state: { where: [], sort: [], q: null, source: null },
      columns: null,
      droppedColumns: [],
      notify: null,
      health: 'broken',
      problems: ['저장된 조건의 모양을 읽지 못했어요. 표에서 조건을 다시 걸어 저장해 주세요.'],
    }
  }

  const def: ViewDefinition = parsed.data
  const validation = validateViewDefinition(def, fields, hosts)
  const pruned = pruneViewColumns(def.columns, fields)
  return {
    ...base,
    name: def.name,
    state: { where: def.where, sort: def.sort, q: def.q, source: def.source },
    columns: pruned.columns,
    droppedColumns: pruned.dropped,
    notify: def.notify,
    pinned: def.pinned,
    health: validation.ok ? 'ok' : 'broken',
    problems: validation.errors,
  }
}

const VIEW_COLUMNS = {
  id: views.id,
  slug: views.slug,
  name: views.name,
  where_json: views.where_json,
  sort_json: views.sort_json,
  search_q: views.search_q,
  source_host: views.source_host,
  columns_json: views.columns_json,
  notify_json: views.notify_json,
  pinned: views.pinned,
  created_at: views.created_at,
} as const

/** 이 컬렉션의 저장된 뷰들 (고정 먼저, 만든 순) */
export async function loadStoredViews(
  db: Db,
  collectionId: string,
  fields: readonly FieldDef[],
  hosts?: readonly string[],
): Promise<StoredView[]> {
  const rows = await db
    .select(VIEW_COLUMNS)
    .from(views)
    .where(eq(views.collection_id, collectionId))
    .orderBy(desc(views.pinned), asc(views.created_at), asc(views.id))
  return rows.map((row) => parseStoredView(row as StoredViewRow, fields, hosts))
}

/** slug 로 뷰 하나. 없으면 null */
export async function loadStoredView(
  db: Db,
  collectionId: string,
  slug: string,
  fields: readonly FieldDef[],
  hosts?: readonly string[],
): Promise<StoredView | null> {
  const rows = await db
    .select(VIEW_COLUMNS)
    .from(views)
    .where(and(eq(views.collection_id, collectionId), eq(views.slug, slug)))
    .limit(1)
  const row = rows[0]
  return row === undefined ? null : parseStoredView(row as StoredViewRow, fields, hosts)
}

// ── 조건 얹기 (순수) ─────────────────────────────────────────────────────

function invalid(message: string, param?: string): QueryProblem {
  return param === undefined ? { code: 'invalid_query', message } : { code: 'invalid_query', message, param }
}

/** 같은 타입끼리만 비교한다 — date 는 YYYY-MM-DD 문자열(사전순 = 시간순), 숫자는 수치 */
function tighter(prev: string | number, next: string | number, dir: 'gte' | 'lte'): string | number {
  if (typeof prev !== typeof next) return next
  const nextIsBigger = prev < next
  return dir === 'gte' ? (nextIsBigger ? next : prev) : nextIsBigger ? prev : next
}

/** `since` 는 날짜 또는 ISO 시각 — 시각으로 견줘 늦은 쪽(더 좁은 쪽)을 쓴다 */
function laterInstant(a: string, b: string): string {
  const ta = Date.parse(a.length === 10 ? `${a}T00:00:00.000Z` : a)
  const tb = Date.parse(b.length === 10 ? `${b}T00:00:00.000Z` : b)
  return tb > ta ? b : a
}

/**
 * 뷰(또는 표의 지금 조건) 위에 요청 조건을 **AND 로** 얹는다 (A46 ③).
 *
 *  - 범위(gte/lte)·since 는 좁은 쪽이 이긴다 — 둘 다 만족해야 하므로 교집합이다
 *  - 하나뿐인 조건(q · source · 같은 칸 완전일치)이 서로 다르면 **거절**한다 — 하나를 골라
 *    적용하면 사용자가 본 뷰와 다른 결과가 나오고, 둘 다 적용할 표현이 없다
 *  - 뷰에만 있는 술어(in · contains · is_null …)는 그대로 간다
 *  - 정렬은 요청이 정할 수 있다(결과 집합을 넓히지 않는다). 개수·커서·include 는 요청의 것
 */
export function overlayQueries(
  base: CollectionQuery,
  user: CollectionQuery,
): { ok: true; query: CollectionQuery } | { ok: false; problems: QueryProblem[] } {
  const problems: QueryProblem[] = []

  const eqOut: CollectionQuery['eq'] = { ...base.eq }
  for (const [key, value] of Object.entries(user.eq)) {
    const prev = eqOut[key]
    if (prev !== undefined && prev !== value) {
      problems.push(invalid(`저장된 조건에 이미 '${key}=${String(prev)}' 가 있어 '${key}=${String(value)}' 를 함께 걸 수 없습니다`, key))
      continue
    }
    eqOut[key] = value
  }

  const gteOut: CollectionQuery['gte'] = { ...base.gte }
  for (const [key, value] of Object.entries(user.gte)) {
    const prev = gteOut[key]
    gteOut[key] = prev === undefined ? value : tighter(prev, value, 'gte')
  }
  const lteOut: CollectionQuery['lte'] = { ...base.lte }
  for (const [key, value] of Object.entries(user.lte)) {
    const prev = lteOut[key]
    lteOut[key] = prev === undefined ? value : tighter(prev, value, 'lte')
  }

  let q = base.q
  if (user.q !== undefined) {
    if (base.q !== undefined && base.q !== user.q) {
      problems.push(invalid(`저장된 조건에 이미 검색어 '${base.q}' 가 있어 다른 검색어를 함께 걸 수 없습니다`, 'q'))
    } else {
      q = user.q
    }
  }

  let source = base.source
  if (user.source !== undefined) {
    if (base.source !== undefined && !hostMatches(base.source, user.source)) {
      problems.push(invalid(`저장된 조건이 이미 출처 '${base.source}' 로 좁혀져 있어 다른 출처를 걸 수 없습니다`, 'source'))
    } else {
      source = user.source
    }
  }

  const since =
    base.since !== undefined && user.since !== undefined
      ? laterInstant(base.since, user.since)
      : (user.since ?? base.since)

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    query: {
      ...base,
      eq: eqOut,
      gte: gteOut,
      lte: lteOut,
      q,
      source,
      since,
      sort: user.sort ?? base.sort,
      limit: user.limit,
      cursor: user.cursor,
      include: user.include,
    },
  }
}

/**
 * 커서가 **이 요청의** 이어보기인지 본다 (A46 ④). 아니면 문제 하나.
 * 지문이 다르면(조건·정렬을 바꿨다) 처음부터 다시 받으라고 말한다.
 */
export function checkCursor(query: CollectionQuery, fields: readonly FieldDef[]): QueryProblem | null {
  if (query.cursor === null) return null
  const decoded = decodeCursor(query.cursor)
  if (decoded === null) {
    return {
      code: 'invalid_cursor',
      message: '이어보기 정보(cursor)를 읽지 못했습니다. 직전 응답의 next_cursor 를 그대로 보내거나, 빼고 처음부터 요청하세요',
      param: 'cursor',
    }
  }
  if (decoded.f !== queryFingerprint(query)) {
    return {
      code: 'invalid_cursor',
      message:
        '이어보기 정보(cursor)가 다른 조건이나 정렬로 받은 것입니다. 조건이나 정렬을 바꾸면 cursor 없이 처음부터 다시 요청하세요',
      param: 'cursor',
    }
  }
  if (buildCursorWhere(resolveSort(query.sort, fields), decoded) === null) {
    return {
      code: 'invalid_cursor',
      message: '이어보기 정보(cursor)가 정렬 기준과 맞지 않습니다. cursor 없이 처음부터 다시 요청하세요',
      param: 'cursor',
    }
  }
  return null
}

export interface ResolveInput {
  fields: readonly FieldDef[]
  /** 요청 파라미터 — REST 쿼리 문자열 · MCP 도구 인자 · 웹 표의 페이지 파라미터 */
  params: QueryParamsInput
  /** 그 아래 깔리는 조회 상태 — 저장된 뷰 또는 웹 표의 지금 조건. 없으면 null */
  base?: ViewQueryState | null
  /** 상대 날짜(this_month · D-7)를 풀 기준 시각 */
  now: Date
}

/**
 * 파라미터 → (뷰 위에 AND) → 커서 확인 → 실행할 쿼리. **순수 함수**.
 * 문제가 하나라도 있으면 쿼리를 내지 않는다.
 */
export function resolveCollectionRequest(
  input: ResolveInput,
): { ok: true; query: CollectionQuery } | { ok: false; problems: QueryProblem[] } {
  const parsed = parseCollectionQuery(input.params, input.fields)
  if (!parsed.ok) return parsed

  let query = parsed.query
  if (input.base !== undefined && input.base !== null) {
    const baseQuery = viewToQuery(input.base, input.now)
    const merged = overlayQueries(baseQuery, query)
    if (!merged.ok) return merged
    query = merged.query
  }

  const cursorProblem = checkCursor(query, input.fields)
  if (cursorProblem !== null) return { ok: false, problems: [cursorProblem] }

  return { ok: true, query }
}

// ── 실행 ─────────────────────────────────────────────────────────────────

export type CollectionRequestOutcome =
  | {
      ok: true
      response: CollectionResponse
      /** 실제로 실행한 쿼리 (화면이 "지금 조건" 을 그릴 때 쓴다) */
      query: CollectionQuery
      /** `viewSlug` 로 불렀으면 그 뷰 */
      view: StoredView | null
      sourceRows: SourceStateLike[]
    }
  | {
      ok: false
      code: ApiErrorCode
      message: string
      problems: QueryProblem[]
      view: StoredView | null
    }

export interface CollectionRequestInput {
  params: QueryParamsInput
  /** REST `?view=` · MCP 뷰 도구. `base` 와 같이 줄 수 없다 */
  viewSlug?: string | null
  /** 웹 표의 지금 조건 (저장 전 상태) */
  base?: ViewQueryState | null
  now?: Date
}

/** 문제 목록 → 대표 문장 하나 (REST error.message · MCP 텍스트 첫 줄) */
export function summarizeProblems(problems: readonly QueryProblem[]): string {
  if (problems.length === 1) return problems[0]?.message ?? '조건을 이해하지 못했습니다'
  return `조건 ${problems.length}개를 적용할 수 없습니다: ${problems.map((p) => p.message).join(' / ')}`
}

/**
 * 표·REST·MCP 의 공통 본체 — 소스 읽기 → 뷰 읽기·판정 → 해석 → 실행.
 * 여기서 throw 하는 것은 DB 장애뿐이다. 조건 문제는 전부 값으로 돌아온다.
 */
export async function runCollectionRequest(
  db: Db,
  collection: CollectionLike,
  input: CollectionRequestInput,
): Promise<CollectionRequestOutcome> {
  const now = input.now ?? new Date()
  const fields = collection.schema_json
  const sourceRows = await loadSourceStates(db, collection.id)
  const hosts = [...new Set(sourceRows.map((s) => s.host))]

  let view: StoredView | null = null
  let base: ViewQueryState | null = input.base ?? null

  const slug = input.viewSlug?.trim() ?? ''
  if (slug !== '') {
    view = await loadStoredView(db, collection.id, slug, fields, hosts)
    if (view === null) {
      const problems: QueryProblem[] = [
        {
          code: 'view_not_found',
          message: `저장된 조건 '${slug}' 을(를) 찾지 못했습니다. 이름(주소)을 확인하거나 조건 없이 요청하세요`,
          param: 'view',
        },
      ]
      return { ok: false, code: 'view_not_found', message: summarizeProblems(problems), problems, view: null }
    }
    if (view.health === 'broken') {
      const problems: QueryProblem[] = [
        {
          code: 'view_unavailable',
          message: `저장된 조건 '${view.name}' 은(는) 지금 적용할 수 없습니다 — ${view.problems.join(' ')} 컬렉션 주인이 표에서 조건을 고쳐 다시 저장해야 합니다`,
          param: 'view',
        },
      ]
      return { ok: false, code: 'view_unavailable', message: summarizeProblems(problems), problems, view }
    }
    base = view.state
  } else if (base !== null) {
    // 표의 지금 조건도 저장된 뷰와 같은 검사를 받는다 — 주소창을 손으로 고친 경우가 여기로 온다
    const check = validateViewDefinition(base, fields)
    if (!check.ok) {
      const problems: QueryProblem[] = check.errors.map((message) => ({ code: 'invalid_query', message }))
      return { ok: false, code: 'invalid_query', message: summarizeProblems(problems), problems, view: null }
    }
  }

  const resolved = resolveCollectionRequest({ fields, params: input.params, base, now })
  if (!resolved.ok) {
    return {
      ok: false,
      code: primaryProblemCode(resolved.problems),
      message: summarizeProblems(resolved.problems),
      problems: resolved.problems,
      view,
    }
  }

  const response = await buildCollectionResponse(db, collection, resolved.query, { sourceRows, now })
  return { ok: true, response, query: resolved.query, view, sourceRows }
}
