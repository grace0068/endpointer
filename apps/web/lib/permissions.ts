// 행위자 기준 권한 판정 (ADR A40·A49) — `@/auth`(next-auth)를 끌어오지 않는다.
// 서버 액션은 currentActor()(access.ts) 로 행위자를 얻어 여기를 부르고, 테스트는 행위자를 직접 준다 —
// **같은 판정 함수**다. 바꾸는 요청은 전부 requireManager 를 지난다 (숨긴 버튼은 보안이 아니다).

import { canManageCollection, canViewCollection, type MemberRole } from '@endpointer/core'

import { safeQuery } from './db'

export interface CollectionAccess {
  userId: string | null
  isOwner: boolean
  memberRole: MemberRole | null
  canView: boolean
  canManage: boolean
}

/** 요청한 사람. 로그인 설정 전(데모)에는 authReady=false — 모두 주인으로 본다 (기존 관례) */
export interface Actor {
  userId: string | null
  authReady: boolean
}

const CLOSED: CollectionAccess = {
  userId: null,
  isOwner: false,
  memberRole: null,
  canView: false,
  canManage: false,
}

/** 행위자 기준 판정 — 멤버십은 DB 에서 본다. 조회가 실패하면 닫힌 쪽으로 */
export async function resolveAccessFor(
  collection: { id: string; owner_id: string },
  actor: Actor,
): Promise<CollectionAccess> {
  if (!actor.authReady) {
    return { userId: null, isOwner: true, memberRole: null, canView: true, canManage: true }
  }
  if (actor.userId === null) return CLOSED

  const isOwner = actor.userId === collection.owner_id
  let memberRole: MemberRole | null = null
  if (!isOwner) {
    const found = await safeQuery(async (core) => {
      const rows = await core.queryClient<{ role: string }[]>`
        select role from collection_members
        where collection_id = ${collection.id} and user_id = ${actor.userId}
        limit 1
      `
      return rows[0]?.role ?? null
    })
    // 조회 실패는 닫힌 쪽으로 — 열람 판정에서 기본값은 언제나 잠금이다
    memberRole = found.ok && found.data === 'viewer' ? 'viewer' : null
  }

  const input = { isOwner, memberRole }
  return {
    userId: actor.userId,
    isOwner,
    memberRole,
    canView: canViewCollection(input),
    canManage: canManageCollection(input),
  }
}

/** 바꾸는 요청의 관문 — 주인이 아니면 사람 문장으로 거절한다 */
export async function requireManager(
  collection: { id: string; owner_id: string },
  actor: Actor,
): Promise<{ ok: true; access: CollectionAccess } | { ok: false; message: string }> {
  const access = await resolveAccessFor(collection, actor)
  if (!access.canManage) {
    return {
      ok: false,
      message: access.canView ? '읽기 전용으로 함께 보는 중이라 바꿀 수 없어요. 컬렉션 주인만 바꿀 수 있어요.' : '이 컬렉션의 주인만 바꿀 수 있어요.',
    }
  }
  return { ok: true, access }
}
