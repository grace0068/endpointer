// 공개 REST API 의 공통 부품 — 기획서 12장 · ADR A46·A48.
//
// 세 가지 규칙만 지킨다.
//  1. **모양이 항상 같다.** 실패해도 items/sources/schema_version/page 가 있다.
//     부분 성공이 1급 시민인 제품에서 실패만 다른 모양이면 클라이언트가 두 번 짠다 (원칙 ④).
//  2. **사람 말로 낸다.** 상태 코드와 내부 사정은 본문의 message 에 넣지 않는다 (보장선 B4).
//     기계가 분기할 것은 `error.code` 와 HTTP 상태다 — 둘 다 MCP 와 같은 집합이다 (A46).
//  3. **판정을 여기서 짜지 않는다.** 키 판정은 `@endpointer/core/auth`, 조회 해석은
//     `@endpointer/core/query` 가 한다 — MCP 와 같은 함수다.

import {
  statusForErrorCode,
  type ApiErrorCode,
  type CollectionResponse,
  type QueryProblem,
} from '@endpointer/core'

/** 공개 읽기 전용 API 다. GET 은 어디서든 부를 수 있어야 한다 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

const BASE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** 응답 봉투 — 계약(G0 (2)) + 실패면 error 한 칸 */
export interface PublicApiBody extends CollectionResponse {
  error?: { message: string; code: ApiErrorCode; problems?: QueryProblem[] }
}

const EMPTY: CollectionResponse = {
  items: [],
  sources: {},
  schema_version: 0,
  page: { limit: 0, next_cursor: null, total: 0, offset: 0 },
}

export function jsonResponse(body: PublicApiBody, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: BASE_HEADERS })
}

/** 실패도 같은 모양으로. 클라이언트가 `items` 를 그냥 읽어도 터지지 않는다. 상태 코드는 코드가 정한다 */
export function errorResponse(code: ApiErrorCode, message: string, problems?: readonly QueryProblem[]): Response {
  return jsonResponse(
    {
      ...EMPTY,
      error: problems !== undefined && problems.length > 0 ? { message, code, problems: [...problems] } : { message, code },
    },
    statusForErrorCode(code),
  )
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/** 사람이 읽을 실패 문구 (조회·인증 문구는 core 가 만든다) */
export const API_MESSAGES = {
  notFound: '이 주소에 해당하는 컬렉션을 찾지 못했어요.',
  unavailable: '지금은 내용을 불러오지 못하고 있어요. 잠시 뒤에 다시 시도해 주세요.',
} as const
