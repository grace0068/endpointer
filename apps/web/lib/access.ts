// 화면 접근 판정 (ADR A40·A49) — 지금 로그인한 사람을 행위자로 바꿔 permissions.ts 에 넘긴다.
//
// 화면은 주인과 멤버만 연다. visibility 는 REST·MCP 의 공개 범위이지 화면 열쇠가 아니다 —
// 이 구분이 없던 것이 "slug 만 알면 남의 컬렉션 화면이 열리던" 구멍이다.

import { currentUser, isAuthReady } from '@/auth'

import { resolveAccessFor, type Actor, type CollectionAccess } from './permissions'

export { requireManager, resolveAccessFor, type Actor, type CollectionAccess } from './permissions'

/** 지금 요청의 행위자 — 서버 액션·서버 컴포넌트에서만 */
export async function currentActor(): Promise<Actor> {
  if (!isAuthReady) return { userId: null, authReady: false }
  const user = await currentUser()
  return { userId: user?.id ?? null, authReady: true }
}

/** 지금 로그인한 사람 기준 (화면용) */
export async function resolveCollectionAccess(collection: {
  id: string
  owner_id: string
}): Promise<CollectionAccess> {
  return resolveAccessFor(collection, await currentActor())
}

