// 공개 REST API — `GET /api/v1/{slug}` (기획서 12장 · G0 계약 (3) · ADR A46·A48).
// 배포에서는 Caddy 가 api.example.com/* 를 여기로 붙인다.
//
// 여기에 로직을 다시 짜지 않는다. 키 판정은 core/auth, 해석·실행은 core/query 의
// runCollectionRequest 하나 — MCP 도구와 **같은 함수**라서 같은 입력이면 성공·실패와 원인이 같다.
//
// `?view={slug}`: 저장된 뷰가 바탕이 되고, 요청 조건은 그 위에 **AND 로만** 얹힌다 (A46 ③ —
// 뷰 계약 §4 의 "덮어쓰기" 를 대체). 없는 뷰는 404, 쓸 수 없게 된 뷰는 422 — 뷰를 빼고
// 더 넓은 결과를 내지 않는다.

import { bearerToken, decideApiAccess } from '@endpointer/core/auth'
import { runCollectionRequest } from '@endpointer/core/query'

import { getCollectionBySlug } from '@/lib/collections'
import { loadCore } from '@/lib/db'
import { API_MESSAGES, errorResponse, jsonResponse, preflightResponse } from '@/lib/public-api'

// 필터·정렬·커서가 매 요청 다르다. 캐시하면 부분 성공 상태가 굳어버린다
export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ collection: string }>
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { collection: slug } = await context.params

  const found = await getCollectionBySlug(slug)
  if (!found.ok) return errorResponse('unavailable', API_MESSAGES.unavailable)
  const collection = found.data
  if (collection === null) return errorResponse('not_found', API_MESSAGES.notFound)

  // private 만 키를 본다. 판정은 MCP 와 같은 함수 (A48). 키는 헤더로만 받는다 — URL 에 싣지 않는다
  const access = decideApiAccess(collection, bearerToken(request.headers.get('authorization')))
  if (!access.ok) return errorResponse(access.code, access.message)

  const core = await loadCore()
  if (core === null) return errorResponse('unavailable', API_MESSAGES.unavailable)

  const url = new URL(request.url)
  // view 는 여기서 소비한다 — 조회 파라미터가 아니다
  const viewSlug = url.searchParams.get('view')
  if (url.searchParams.getAll('view').length > 1) {
    return errorResponse('invalid_query', '같은 조건이 여러 번 왔습니다: view. 하나만 보내 주세요', [
      { code: 'invalid_query', message: '같은 조건이 여러 번 왔습니다: view. 하나만 보내 주세요', param: 'view' },
    ])
  }
  url.searchParams.delete('view')

  try {
    const outcome = await runCollectionRequest(core.db, collection, {
      params: url.searchParams,
      viewSlug,
    })
    if (!outcome.ok) return errorResponse(outcome.code, outcome.message, outcome.problems)
    return jsonResponse(outcome.response)
  } catch (cause) {
    // 조회가 통째로 실패해도 모양은 지킨다. 원인은 로그로만 (B4)
    console.warn('[endpointer/web] 공개 응답을 만들지 못했습니다', cause)
    return errorResponse('unavailable', API_MESSAGES.unavailable)
  }
}

export async function OPTIONS(): Promise<Response> {
  return preflightResponse()
}
