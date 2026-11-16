'use server'

// 컬렉션 관리 서버 액션 — 이름 변경·삭제. 주인만 할 수 있다.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { VisibilitySchema } from '@endpointer/core'

import type { ManageState } from '@/components/collection-manage'
import { deleteCollection, renameCollection, updateCollectionVisibility } from '@/lib/collections'
import { setCollectionListed } from '@/lib/gallery'
import { managedCollection } from '@/lib/guard'

/** 주인 확인 — 공통 관문 (lib/guard · A49). 로그인 설정 전(데모)에는 통과시킨다 */
async function ownedCollection(
  slug: string,
): Promise<{ ok: true; id: string; visibility: string } | { ok: false; message: string }> {
  const managed = await managedCollection(slug)
  if (!managed.ok) return managed
  return { ok: true, id: managed.collection.id, visibility: managed.collection.visibility }
}

export async function renameCollectionAction(
  slug: string,
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const name = String(formData.get('name') ?? '').trim()
  if (name === '') return { status: 'problem', message: '이름을 비워둘 수는 없어요.' }
  if (name.length > 100) return { status: 'problem', message: '이름이 너무 길어요. 100자 안으로 지어 주세요.' }

  const owned = await ownedCollection(slug)
  if (!owned.ok) return { status: 'problem', message: owned.message }

  const result = await renameCollection(owned.id, name)
  if (!result.ok) return { status: 'problem', message: result.message }

  revalidatePath(`/collections/${slug}`, 'layout')
  revalidatePath('/collections')
  return { status: 'done', message: '이름을 바꿨어요.' }
}

export async function updateVisibilityAction(
  slug: string,
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const parsed = VisibilitySchema.safeParse(formData.get('visibility'))
  if (!parsed.success) return { status: 'problem', message: '고를 수 없는 값이에요.' }

  const owned = await ownedCollection(slug)
  if (!owned.ok) return { status: 'problem', message: owned.message }

  const result = await updateCollectionVisibility(owned.id, parsed.data)
  if (!result.ok) return { status: 'problem', message: result.message }

  revalidatePath(`/collections/${slug}`, 'layout')
  revalidatePath('/gallery')
  return {
    status: 'done',
    message: result.data.unlisted
      ? '공개범위를 바꿨어요. 공개가 아니게 되어 모두의 컬렉션에서도 내렸어요.'
      : '공개범위를 바꿨어요.',
  }
}

export async function updateListedAction(
  slug: string,
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  // 체크박스는 켜졌을 때만 값을 보낸다 — 없으면 끈 것
  const listed = formData.get('listed') === 'on' || formData.get('listed') === 'true'

  const managed = await managedCollection(slug)
  if (!managed.ok) return { status: 'problem', message: managed.message }

  const result = await setCollectionListed(
    { id: managed.collection.id, visibility: managed.collection.visibility },
    listed,
  )
  if (!result.ok) return { status: 'problem', message: result.message }

  revalidatePath(`/collections/${slug}/settings`)
  revalidatePath('/gallery')
  return { status: 'done', message: listed ? '모두의 컬렉션에 올렸어요.' : '모두의 컬렉션에서 내렸어요.' }
}

export async function deleteCollectionAction(slug: string, _formData: FormData): Promise<void> {
  const owned = await ownedCollection(slug)
  if (!owned.ok) return

  await deleteCollection(owned.id)
  revalidatePath('/collections')
  redirect('/collections')
}
