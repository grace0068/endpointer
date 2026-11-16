// API 키 — 발급·해시·판정 (ADR A48). REST(web) 와 MCP 가 **같은 함수**를 쓴다.
//
// 전에는 같은 판정이 web(`lib/public-api.ts`)과 mcp(`src/auth.ts`)에 두 벌 있었다 —
// mcp 쪽 TODO 가 "core 로 올려라" 였다. 여기가 그 자리다.
//
// ── node 전용 ────────────────────────────────────────────────────────────
// `node:crypto` 를 쓰므로 **루트 배럴(`@endpointer/core`)에 넣지 않는다.** core 의 나머지는
// 브라우저에서도 돌아야 한다 (A18). 서버 표면만 `@endpointer/core/auth` 로 들어온다.
//
// ── 왜 느린 해시가 아닌가 ────────────────────────────────────────────────
// 키는 사람이 고른 비밀번호가 아니라 서버가 만든 256비트 난수다. bcrypt·argon2 는 저엔트로피
// 입력의 사전 공격을 늦추는 장치라 여기선 쓸모가 없고, 매 요청마다 도는 경로라 빠른 SHA-256 이 맞다.
// 비교는 타이밍 안전하게 한다.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { Visibility } from '../types/collection'

/** 키 앞에 붙는 표식 — 로그·코드에서 실수로 섞여 들어간 키를 사람이 알아보게 한다 */
export const API_KEY_PREFIX = 'ep_'

/** 원문 키에서 식별용으로 저장하는 앞 글자 수 (`ep_` + 4자). 비밀이 아니다 */
export const API_KEY_HINT_LENGTH = 7

export interface IssuedApiKey {
  /** 원문 — **발급 응답에서 한 번만** 사용자에게 보인다. 저장·로그 금지 */
  key: string
  /** 저장용 SHA-256 hex */
  hash: string
  /** 저장용 앞 글자 */
  hint: string
}

/** 32바이트 난수(256비트) → `ep_` + base64url */
export function generateApiKey(): IssuedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  return { key, hash: hashApiKey(key), hint: key.slice(0, API_KEY_HINT_LENGTH) }
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** 길이가 다르면 timingSafeEqual 이 던지므로 먼저 거른다 */
export function apiKeyMatches(presented: string | null, storedHash: string | null): boolean {
  if (!presented || !storedHash) return false
  const a = Buffer.from(hashApiKey(presented), 'hex')
  const b = Buffer.from(storedHash.trim().toLowerCase(), 'hex')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * `Authorization: Bearer xxx` 에서 키를 꺼낸다. 다른 스킴이면 null.
 * 헤더가 배열로 오는 경우(중복 헤더)는 첫 번째만 본다.
 */
export function bearerToken(header: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string') return null
  const m = /^Bearer[ \t]+(.+)$/i.exec(raw.trim())
  const token = m?.[1]?.trim()
  return token ? token : null
}

/** 문구는 REST 본문·MCP 오류 텍스트에 그대로 나간다 (B2·B4 — 내부 명사·HTTP 코드 없음) */
export const ACCESS_MESSAGES = {
  notFound: '그런 주소의 컬렉션을 찾지 못했습니다.',
  keyRequired:
    '비공개 컬렉션이라 API 키가 필요합니다. Authorization: Bearer <키> 헤더로 보내 주세요. 키는 컬렉션 주인이 연결 화면에서 발급합니다.',
  keyRejected:
    'API 키가 맞지 않습니다. 키가 교체되거나 폐기됐을 수 있습니다 — 컬렉션 주인에게 새 키를 받아 주세요.',
} as const

export type ApiAccessDecision =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'unauthorized'; message: string }

/**
 * REST·MCP 공통 판정 (기획서 12장 · A48).
 *   public · unlisted → 키 없이 열린다 (unlisted 는 추측 불가 slug 가 곧 열쇠)
 *   private           → 지금 저장된 키와 맞아야 한다. 키가 폐기돼 없으면 아무도 못 연다
 */
export function decideApiAccess(
  collection: { visibility: Visibility; api_key_hash: string | null } | null | undefined,
  presentedKey: string | null,
): ApiAccessDecision {
  if (!collection) return { ok: false, code: 'not_found', message: ACCESS_MESSAGES.notFound }
  switch (collection.visibility) {
    case 'public':
    case 'unlisted':
      return { ok: true }
    case 'private':
      if (presentedKey === null) return { ok: false, code: 'unauthorized', message: ACCESS_MESSAGES.keyRequired }
      if (!apiKeyMatches(presentedKey, collection.api_key_hash)) {
        return { ok: false, code: 'unauthorized', message: ACCESS_MESSAGES.keyRejected }
      }
      return { ok: true }
    default:
      // Visibility 가 늘었는데 여기를 안 고쳤다는 뜻. 열어주지 않는 쪽으로 실패한다
      return { ok: false, code: 'not_found', message: ACCESS_MESSAGES.notFound }
  }
}
