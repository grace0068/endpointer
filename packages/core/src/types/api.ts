// 공개 API 응답 계약 — 기획서 7장④ · 12장 · 트랙 계약 #3
// 이 형태는 트랙 A·B 가 공유한다. 혼자 바꾸면 상대 트랙이 조용히 깨진다.
//
// 경로: `GET /api/v1/{slug}` (배포 시 Caddy 가 api.example.com/* 로 붙인다)

import { z } from 'zod'
import type { FieldDef } from './collection'
import type { ItemProvenance, ItemRaw, ItemValue } from './item'
import { SourceStatusSchema, type SourceStatus } from './source'

/** 기본 페이지 크기와 상한 (기획서 12장 `?limit=`) */
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

/** 응답 아이템에 붙는 메타 키 — 스키마 필드 키와 섞이지 않게 `_` 접두사를 쓴다 */
export interface ApiItemMeta {
  /** 출처 호스트명 */
  _source: string
  /** ISO 8601. 신규 판정 기준 (`?since=`) */
  _first_seen_at: string
  /** link 타입 필드가 있으면 그 값, 없으면 null */
  _link: string | null
  /** `?include=provenance` 일 때만 */
  _provenance?: ItemProvenance
  /** `?include=provenance` 일 때만 — 원문 대조용 원본 조각 */
  _raw?: ItemRaw
}

/** data_json 이 펼쳐진 형태 + 메타. 나머지 키는 컬렉션 스키마의 필드 키다 */
export type ApiItem = { [key: string]: ItemValue | ItemProvenance | ItemRaw | undefined } & ApiItemMeta

/**
 * 소스별 상태. 부분 성공이 1급 시민이다 (원칙 ④ · ADR A4).
 * `sources` 는 옵션이 아니라 **항상 포함된다.**
 */
export const SourceSummarySchema = z.object({
  status: SourceStatusSchema,
  /** 이번 응답에 이 소스가 기여한 아이템 수 */
  items: z.number().int().min(0),
  /** `healing` 일 때 마지막 성공 데이터의 나이. 예 "6h" */
  age: z.string().optional(),
  last_ok_at: z.string().nullable().optional(),
})

export interface SourceSummary {
  status: SourceStatus
  items: number
  age?: string
  last_ok_at?: string | null
}

/**
 * 페이지 정보. `total`·`offset` 은 A46 에서 **덧붙인** 칸이다 (기존 클라이언트는 무시하면 된다).
 *  - total  : 이 조건에 맞는 전체 개수 (페이지가 아니라 조건 기준)
 *  - offset : 이 페이지의 첫 항목이 전체에서 몇 번째인지 (0부터). 커서가 실어 나른다
 */
export interface PageInfo {
  limit: number
  next_cursor: string | null
  total: number
  offset: number
}

/** `GET /api/v1/{slug}` 응답. G0 계약 (2) */
export interface CollectionResponse {
  items: ApiItem[]
  /** 키는 호스트명 */
  sources: Record<string, SourceSummary>
  schema_version: number
  page: PageInfo
}

/**
 * 오류 코드 — REST·MCP 가 같은 집합을 쓴다 (ADR A46).
 * 같은 입력이면 두 표면의 성공·실패와 코드가 같아야 한다. 상태 코드는 `statusForErrorCode`.
 * `bad_request` 는 A46 이전의 범용 코드라 남겨 두지만 새 코드는 쓰지 않는다.
 */
export const API_ERROR_CODES = [
  'not_found',
  'unauthorized',
  'bad_request',
  'unavailable',
  'invalid_query',
  'limit_exceeded',
  'invalid_cursor',
  'view_not_found',
  'view_unavailable',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** 요청 조건 때문에 생기는 오류만 — 인증·존재·가용성은 별도 */
export const QUERY_ERROR_CODES = [
  'invalid_query',
  'limit_exceeded',
  'invalid_cursor',
  'view_not_found',
  'view_unavailable',
] as const
export type QueryErrorCode = (typeof QUERY_ERROR_CODES)[number]

/**
 * 적용할 수 없는 조건 하나. **조용히 버리지 않고 실패로 돌려준다** (A46).
 * message 는 사용자의 AI·개발자가 그대로 읽는 한국어 문장이다 (B2·B4).
 */
export interface QueryProblem {
  code: QueryErrorCode
  message: string
  /** 문제가 된 파라미터 이름 (있으면) */
  param?: string
}

/** HTTP 상태 코드 — REST 만 쓴다. MCP 는 isError 결과에 같은 code 를 싣는다 */
export function statusForErrorCode(code: ApiErrorCode): number {
  switch (code) {
    case 'not_found':
    case 'view_not_found':
      return 404
    case 'unauthorized':
      return 401
    case 'view_unavailable':
      return 422
    case 'unavailable':
      return 503
    case 'bad_request':
    case 'invalid_query':
    case 'limit_exceeded':
    case 'invalid_cursor':
      return 400
  }
}

/** 여러 문제가 한꺼번에 있으면 가장 구체적인 것을 대표 코드로 삼는다 */
export function primaryProblemCode(problems: readonly QueryProblem[]): QueryErrorCode {
  const order: QueryErrorCode[] = ['view_not_found', 'view_unavailable', 'invalid_cursor', 'limit_exceeded', 'invalid_query']
  for (const code of order) if (problems.some((p) => p.code === code)) return code
  return 'invalid_query'
}

/** 실패도 사람 말로 낸다. HTTP 코드·스택 트레이스를 노출하지 않는다 (보장선 B4) */
export interface ApiErrorResponse {
  error: {
    /** 한국어 상태 문구 */
    message: string
    /** 클라이언트 분기용 기계 코드. 화면에 그대로 띄우지 않는다 */
    code: ApiErrorCode
    /** 조건 때문에 실패했으면 무엇이 문제였는지 전부 */
    problems?: QueryProblem[]
  }
}

// ── 쿼리 파라미터 (기획서 12장 표) ─────────────────────────────────────

export const SORT_PATTERN = /^-?[a-z][a-z0-9_]*$/

/**
 * 파싱된 쿼리. 구독의 `filter_json` 도 같은 형태를 저장한다
 * (표에서 건 필터 그대로 — 기획서 10장 `subscriptions.filter_json`).
 */
export const CollectionQuerySchema = z.object({
  /** 필드 완전일치. 예) `?category=rnd` */
  eq: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** date·number·money 타입에만. 예) `?deadline_gte=2026-08-01` */
  gte: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** date·number·money 타입에만. 예) `?amount_lte=100000000` */
  lte: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  // ── 아래 다섯은 뷰 계약(A33·A35)이 추가했다. 기본값이 있어 기존 쿼리는 그대로 동작한다.
  //    URL 파라미터로는 받지 않는다 — 저장된 뷰·웹 표의 조건(stateToQuery)만 채운다.
  /** 값이 목록 중 하나 (enum). 빈 배열은 허용하지 않는다 — 파싱이 거른다 */
  in: z.record(z.string(), z.array(z.union([z.string(), z.number()])).min(1)).default({}),
  /** 값이 목록에 없음 (enum). 값이 비어 있는 행도 "목록에 없음"으로 포함된다 */
  not_in: z.record(z.string(), z.array(z.union([z.string(), z.number()])).min(1)).default({}),
  /** 특정 text 필드가 이 문자열을 포함 (`q` 는 전 필드 대상, 이건 한 필드 대상) */
  contains: z.record(z.string(), z.string().min(1)).default({}),
  /** 특정 text 필드가 이 문자열을 포함하지 않음. 값이 비어 있는 행도 포함된다 */
  not_contains: z.record(z.string(), z.string().min(1)).default({}),
  /** 값이 비어 있는 행만 (`상시` 같은 것). 빈 문자열도 "비어 있음"으로 본다 */
  is_null: z.array(z.string()).default([]),
  /** text 타입 필드 전체 대상 검색 */
  q: z.string().optional(),
  /** 출처 호스트명 */
  source: z.string().optional(),
  /** `first_seen_at` 기준. ISO 날짜 */
  since: z.string().optional(),
  /** `deadline` / `-amount` — `-` 가 내림차순 */
  sort: z.string().regex(SORT_PATTERN).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().nullable().default(null),
  /** `?include=provenance` */
  include: z.array(z.enum(['provenance'])).default([]),
})

export type CollectionQuery = z.infer<typeof CollectionQuerySchema>
/** 구독 조건 — 페이지네이션을 뺀 필터 부분만 저장한다 */
export type CollectionFilter = Omit<CollectionQuery, 'limit' | 'cursor' | 'include'>

// ── MCP 도구 응답 (기획서 12장) ────────────────────────────────────────

/** `get_schema` */
export interface SchemaResponse {
  slug: string
  name: string
  schema_version: number
  fields: FieldDef[]
}

/** `get_sources_status` — 원칙 ④ 가 MCP 에서도 노출되는 지점 */
export interface SourcesStatusResponse {
  sources: Record<string, SourceSummary>
}
