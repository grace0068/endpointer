// 비공개 컬렉션의 API 키 — 발급·교체·폐기 (ADR A48).
//
// 규칙:
//  - **주인만** 한다. 행위자를 받아 requireManager 를 지난다 (서버 액션·테스트가 같은 함수).
//  - 키는 core 가 만든다(256비트 난수). DB 에는 해시와 앞 7자(식별용)와 발급 시각만 남는다.
//  - 원문은 **이 함수의 반환값으로 한 번만** 나간다. 로그·주소·revalidate 경로·분석 이벤트에 싣지 않는다.
//  - 발급과 교체는 같은 연산이다 — 해시를 덮어쓰면 옛 키는 그 순간 REST·MCP 모두에서 무효다
//    (두 표면이 같은 해시를 같은 함수로 대조한다).
//  - 폐기는 해시를 지운다 — 비공개 컬렉션은 다시 발급할 때까지 API 로 아무도 못 연다.

import { generateApiKey } from '@endpointer/core/auth'

import { asDate } from './collections'
import { safeQuery, type Loaded } from './db'
import { requireManager, type Actor } from './permissions'

export interface ApiKeyStatus {
  /** 지금 유효한 키가 있나 */
  active: boolean
  /** 키를 알아보는 앞 글자 (`ep_ab12`) — 비밀이 아니다 */
  hint: string | null
  createdAt: Date | null
}

export async function getApiKeyStatus(collectionId: string): Promise<Loaded<ApiKeyStatus>> {
  return safeQuery(async (core) => {
    const rows = await core.queryClient<{ api_key_hash: string | null; api_key_hint: string | null; api_key_created_at: Date | string | null }[]>`
      select api_key_hash, api_key_hint, api_key_created_at from collections where id = ${collectionId} limit 1
    `
    const row = rows[0]
    const active = row?.api_key_hash !== null && row?.api_key_hash !== undefined
    return {
      active,
      hint: active ? (row?.api_key_hint ?? null) : null,
      // 원시 질의는 timestamptz 를 문자열로 준다 — Date 로 굳히지 않으면 연결 화면이 Intl 포맷에서 죽는다
      createdAt: active ? asDate(row?.api_key_created_at ?? null) : null,
    }
  })
}

export type IssueResult =
  | { ok: true; key: string; hint: string; replaced: boolean }
  | { ok: false; message: string }

/** 발급 또는 교체. 원문 키는 이 반환값에만 있다 — 호출한 쪽도 저장·로그하지 마라 */
export async function issueApiKey(
  collection: { id: string; owner_id: string },
  actor: Actor,
): Promise<IssueResult> {
  const guard = await requireManager(collection, actor)
  if (!guard.ok) return guard

  const issued = generateApiKey()
  const result = await safeQuery(async (core) => {
    const rows = await core.queryClient<{ replaced: boolean }[]>`
      update collections c
         set api_key_hash = ${issued.hash}, api_key_hint = ${issued.hint}, api_key_created_at = now(), updated_at = now()
        from (select api_key_hash is not null as replaced from collections where id = ${collection.id}) prev
       where c.id = ${collection.id}
      returning prev.replaced
    `
    return rows[0]?.replaced ?? false
  })
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, key: issued.key, hint: issued.hint, replaced: result.data }
}

/** 폐기 — 해시를 지운다. 이미 없으면 그대로 성공 (같은 결과) */
export async function revokeApiKey(
  collection: { id: string; owner_id: string },
  actor: Actor,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const guard = await requireManager(collection, actor)
  if (!guard.ok) return guard
  const result = await safeQuery(async (core) => {
    await core.queryClient`
      update collections set api_key_hash = null, api_key_hint = null, api_key_created_at = null, updated_at = now()
      where id = ${collection.id}
    `
    return null
  })
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}
