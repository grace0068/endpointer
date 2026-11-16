'use server'

// API 키 발급·교체·폐기 (ADR A48). 주인만 — lib/api-keys 가 행위자로 다시 판정한다.
//
// 원문 키는 **이 액션의 반환값에만** 실린다. 로그·revalidate 경로·리다이렉트 주소에 넣지 않는다 —
// 다시 조회할 방법이 없다(해시만 저장). 화면은 이 응답을 받은 그 순간에만 보여준다.

import { revalidatePath } from 'next/cache'

import { currentActor } from '@/lib/access'
import { issueApiKey, revokeApiKey } from '@/lib/api-keys'
import { getCollectionBySlug } from '@/lib/collections'

export interface KeyState {
  status: 'idle' | 'done' | 'problem'
  message: string | null
  /** 방금 만든 원문 키 — 이 응답에서만 보이고 다시 볼 수 없다 */
  key: string | null
}

async function load(slug: string) {
  const found = await getCollectionBySlug(slug)
  if (!found.ok) return { ok: false as const, message: found.message }
  if (found.data === null) return { ok: false as const, message: '이 컬렉션을 찾지 못했어요.' }
  return { ok: true as const, collection: found.data, actor: await currentActor() }
}

export async function issueApiKeyAction(slug: string, _prev: KeyState, _formData: FormData): Promise<KeyState> {
  const loaded = await load(slug)
  if (!loaded.ok) return { status: 'problem', message: loaded.message, key: null }
  const result = await issueApiKey(loaded.collection, loaded.actor)
  if (!result.ok) return { status: 'problem', message: result.message, key: null }
  revalidatePath(`/collections/${slug}/connect`)
  return {
    status: 'done',
    message: result.replaced
      ? '새 키를 만들었어요. 이전 키는 지금부터 쓸 수 없어요. 새 키는 지금만 보여요 — 복사해 두세요.'
      : '키를 만들었어요. 지금만 보여요 — 복사해 두세요.',
    key: result.key,
  }
}

export async function revokeApiKeyAction(slug: string, _prev: KeyState, _formData: FormData): Promise<KeyState> {
  const loaded = await load(slug)
  if (!loaded.ok) return { status: 'problem', message: loaded.message, key: null }
  const result = await revokeApiKey(loaded.collection, loaded.actor)
  if (!result.ok) return { status: 'problem', message: result.message, key: null }
  revalidatePath(`/collections/${slug}/connect`)
  return {
    status: 'done',
    message:
      loaded.collection.visibility === 'private'
        ? '키를 없앴어요. 새 키를 만들 때까지 API·AI 연결로는 아무도 이 컬렉션을 열 수 없어요.'
        : '키를 없앴어요.',
    key: null,
  }
}
