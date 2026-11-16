// 컬렉션 접근 판정 — 기획서 12장 "인증" · ADR A48
//
//   private   → API 키 필요 (`Authorization: Bearer {key}` 가 기본)
//   unlisted  → 추측 불가 slug 만으로 접근 (무인증)
//   public    → 무인증
//
// 판정 자체는 **core 의 `decideApiAccess`** 다 — REST(web) 와 같은 함수 (예전 TODO(G1) 해소).
// 여기 남은 것은 MCP 만의 사정 둘뿐이다:
//
//  1. `?key=` — **폐기 예정 호환 경로** (A48). 주소 칸 하나만 받는 커넥터를 위해 예전 화면이
//     키를 주소에 실어 줬다. 이미 그렇게 연결된 사용자가 끊기지 않게 서버는 계속 받지만,
//     화면은 더 이상 이 주소를 만들지 않는다. 키를 교체하면 이 주소도 함께 무효가 된다.
//     질의 문자열의 키는 어디에도 기록하지 않는다 — 로그에는 "어느 경로로 왔는지" 만 남긴다.
//  2. slug 모양 검사 — 경로 조각이 DB 조회까지 가기 전에 거른다.

import type { Db } from '@endpointer/core/db'
import { bearerToken, decideApiAccess, ACCESS_MESSAGES } from '@endpointer/core/auth'
import type { ApiErrorCode, CollectionSchemaJson, Visibility } from '@endpointer/core'

/** 응답을 만드는 데 실제로 필요한 컬렉션 정보. `collections` 행의 부분집합 */
export interface AccessibleCollection {
  id: string
  slug: string
  name: string
  schema_json: CollectionSchemaJson
  schema_version: number
  visibility: Visibility
  api_key_hash: string | null
}

export type AccessGrant =
  | { ok: true; collection: AccessibleCollection }
  | { ok: false; code: Extract<ApiErrorCode, 'not_found' | 'unauthorized'>; message: string }

/** slug 규약 — URL 과 API 경로에 그대로 들어간다 (기획서 10장 `collections.slug`) */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/** 폐기 예정 — 화면은 더 이상 안내하지 않는다 (머리말 1) */
export const KEY_QUERY_PARAM = 'key'

export type KeyChannel = 'header' | 'query' | 'none'

/**
 * 제시된 키와 그 경로. 헤더가 있으면 헤더가 이긴다.
 * 경로는 로그에 남기고(폐기 예정 경로의 실제 사용량을 보려고), 키 자체는 절대 남기지 않는다.
 */
export function presentedKeyFrom(input: {
  authorization?: string | string[] | undefined
  queryKey?: string | string[] | undefined
}): { key: string | null; channel: KeyChannel } {
  const fromHeader = bearerToken(input.authorization)
  if (fromHeader) return { key: fromHeader, channel: 'header' }
  const raw = Array.isArray(input.queryKey) ? input.queryKey[0] : input.queryKey
  if (typeof raw === 'string' && raw.trim() !== '') return { key: raw.trim(), channel: 'query' }
  return { key: null, channel: 'none' }
}

const ACCESS_COLUMNS = {
  id: true,
  slug: true,
  name: true,
  schema_json: true,
  schema_version: true,
  visibility: true,
  api_key_hash: true,
} as const

/** slug 로 컬렉션을 찾고 core 의 판정으로 접근을 정한다. 여기서 throw 하지 않는다 (DB 장애 제외) */
export async function resolveCollectionAccess(
  db: Db,
  slug: string,
  presentedKey: string | null,
): Promise<AccessGrant> {
  if (!isValidSlug(slug)) {
    return { ok: false, code: 'not_found', message: ACCESS_MESSAGES.notFound }
  }

  const row = await db.query.collections.findFirst({
    where: (c, { eq }) => eq(c.slug, slug),
    columns: ACCESS_COLUMNS,
  })
  if (row === undefined) return { ok: false, code: 'not_found', message: ACCESS_MESSAGES.notFound }

  const decision = decideApiAccess(row, presentedKey)
  if (!decision.ok) return decision
  return { ok: true, collection: row }
}
