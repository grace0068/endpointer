'use server'

// 초대 링크 · 함께 보는 사람 관리 (ADR A40). 전부 주인만 부를 수 있다 —
// 화면에서 숨기는 것과 별개로 여기서도 막는다 (숨긴 버튼은 보안이 아니다).

import { revalidatePath } from 'next/cache'

import { disableInviteLinks, issueInviteLink, removeMember } from '@/lib/share'
import { managedCollection } from '@/lib/guard'
import { inviteUrlFor } from '@/lib/urls'

export interface ShareState {
  status: 'idle' | 'done' | 'problem'
  message: string | null
  /** 새로 만든 초대 링크 — 이 응답에서만 보이고 다시 조회할 수 없다 */
  inviteUrl: string | null
}

/** 주인 확인 — 공통 관문 (lib/guard · A49). 로그인 설정 전(데모)에는 통과시킨다 */
async function ownedCollection(
  slug: string,
): Promise<{ ok: true; id: string; userId: string | null } | { ok: false; message: string }> {
  const managed = await managedCollection(slug)
  if (!managed.ok) return managed
  return {
    ok: true,
    id: managed.collection.id,
    userId: managed.actor.authReady ? managed.actor.userId : managed.collection.owner_id,
  }
}

export async function createInviteLinkAction(
  slug: string,
  _prev: ShareState,
  _formData: FormData,
): Promise<ShareState> {
  const owned = await ownedCollection(slug)
  if (!owned.ok) return { status: 'problem', message: owned.message, inviteUrl: null }
  if (owned.userId === null) {
    return { status: 'problem', message: '로그인이 준비되면 만들 수 있어요.', inviteUrl: null }
  }

  const issued = await issueInviteLink(owned.id, owned.userId)
  if (!issued.ok) return { status: 'problem', message: issued.message, inviteUrl: null }

  revalidatePath(`/collections/${slug}/connect`)
  return {
    status: 'done',
    message: '새 초대 링크를 만들었어요. 지금만 보여요 — 복사해서 전해 주세요.',
    inviteUrl: inviteUrlFor(issued.data.token),
  }
}

export async function disableInviteLinkAction(
  slug: string,
  _prev: ShareState,
  _formData: FormData,
): Promise<ShareState> {
  const owned = await ownedCollection(slug)
  if (!owned.ok) return { status: 'problem', message: owned.message, inviteUrl: null }

  const result = await disableInviteLinks(owned.id)
  if (!result.ok) return { status: 'problem', message: result.message, inviteUrl: null }

  revalidatePath(`/collections/${slug}/connect`)
  return {
    status: 'done',
    message: '초대 링크를 껐어요. 이미 함께 보는 사람은 그대로예요 — 내보내려면 아래 목록에서 내보내기를 눌러 주세요.',
    inviteUrl: null,
  }
}

export async function removeMemberAction(
  slug: string,
  _prev: ShareState,
  formData: FormData,
): Promise<ShareState> {
  const memberId = String(formData.get('member_id') ?? '')
  if (memberId === '') return { status: 'problem', message: '누구를 내보낼지 몰라요.', inviteUrl: null }

  const owned = await ownedCollection(slug)
  if (!owned.ok) return { status: 'problem', message: owned.message, inviteUrl: null }

  const result = await removeMember(owned.id, memberId)
  if (!result.ok) return { status: 'problem', message: result.message, inviteUrl: null }

  revalidatePath(`/collections/${slug}/connect`)
  return {
    status: 'done',
    message:
      '내보냈어요. 화면에는 더 이상 못 들어와요. 다만 그 사람이 이미 아는 API 키·연결 주소는 그대로라, 그것까지 막으려면 연결 화면에서 키를 새로 만들거나 공개범위를 바꿔 주세요.',
    inviteUrl: null,
  }
}
