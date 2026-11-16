'use server'

// 뷰 저장·관리 서버 액션 (뷰 계약 · A47). 실패는 사람 문장 (B4).
// 권한은 lib/views 의 함수들이 행위자를 받아 다시 판정한다 — 여기서 숨긴다고 끝나지 않는다.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { ViewConditionSchema, ViewSortSchema } from '@endpointer/core'
import { z } from 'zod'

import type { ManageState } from '@/components/collection-manage'
import type { SaveViewState } from '@/components/save-view-form'
import { currentActor } from '@/lib/access'
import { getCollectionBySlug } from '@/lib/collections'
import type { TableState } from '@/lib/table-state'
import { createView, deleteView, renameView, setViewNotify, setViewPinned, updateView } from '@/lib/views'

/** 폼의 숨은 칸 `state` — 화면이 지금 보는 상태를 그대로 싣는다 */
const TableStateSchema = z.object({
  where: z.array(ViewConditionSchema).max(10),
  q: z.string().nullable(),
  source: z.string().nullable(),
  sort: z.array(ViewSortSchema).max(1),
  columns: z.array(z.string()).nullable(),
})

function readState(formData: FormData): TableState | null {
  try {
    const parsed = TableStateSchema.safeParse(JSON.parse(String(formData.get('state') ?? '')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function load(slug: string) {
  const found = await getCollectionBySlug(slug)
  if (!found.ok) return { ok: false as const, message: found.message }
  if (found.data === null) return { ok: false as const, message: '이 컬렉션을 찾지 못했어요.' }
  return { ok: true as const, collection: found.data, actor: await currentActor() }
}

/** 지금 상태를 새 뷰로 */
export async function createViewAction(slug: string, _prev: SaveViewState, formData: FormData): Promise<SaveViewState> {
  const state = readState(formData)
  if (state === null) return { status: 'problem', message: '조건을 읽지 못했어요. 화면을 새로 고쳐 주세요.' }
  const loaded = await load(slug)
  if (!loaded.ok) return { status: 'problem', message: loaded.message }

  const result = await createView(loaded.collection, loaded.actor, { name: String(formData.get('name') ?? ''), state })
  if (!result.ok) return { status: 'problem', message: result.message }

  revalidatePath(`/collections/${slug}`, 'layout')
  // 저장한 조건이 바로 적용된 표로 돌아간다 — 결과를 보면서 정의한다 (델타 2-10)
  redirect(`/collections/${slug}/table?view=${result.slug}`)
}

/** 고치던 뷰에 지금 상태를 덮어쓴다 — slug 는 그대로 (주소·AI 도구 이름이 안 끊긴다) */
export async function updateViewAction(slug: string, _prev: SaveViewState, formData: FormData): Promise<SaveViewState> {
  const state = readState(formData)
  const viewSlug = String(formData.get('view_slug') ?? '').trim()
  if (state === null || viewSlug === '') return { status: 'problem', message: '조건을 읽지 못했어요. 화면을 새로 고쳐 주세요.' }
  const loaded = await load(slug)
  if (!loaded.ok) return { status: 'problem', message: loaded.message }

  const name = String(formData.get('name') ?? '').trim()
  const result = await updateView(loaded.collection, loaded.actor, viewSlug, { ...(name !== '' ? { name } : {}), state })
  if (!result.ok) return { status: 'problem', message: result.message }

  revalidatePath(`/collections/${slug}`, 'layout')
  redirect(`/collections/${slug}/table?view=${result.slug}`)
}

/** 이름만 바꾼다 — slug(주소·AI 도구 이름)는 그대로라 연결이 안 끊긴다 */
export async function renameViewAction(slug: string, _prev: ManageState, formData: FormData): Promise<ManageState> {
  const loaded = await load(slug)
  if (!loaded.ok) return { status: 'problem', message: loaded.message }
  const result = await renameView(
    loaded.collection,
    loaded.actor,
    String(formData.get('view_id') ?? '').trim(),
    String(formData.get('name') ?? ''),
  )
  if (!result.ok) return { status: 'problem', message: result.message }
  revalidatePath(`/collections/${slug}`, 'layout')
  // 바뀐 이름이 카드에 바로 보이므로 성공 알림은 따로 띄우지 않는다
  return { status: 'done', message: null }
}

export async function deleteViewAction(slug: string, formData: FormData): Promise<void> {
  const loaded = await load(slug)
  if (!loaded.ok) return
  await deleteView(loaded.collection, loaded.actor, String(formData.get('view_id') ?? '').trim())
  revalidatePath(`/collections/${slug}`, 'layout')
}

export async function toggleViewPinAction(slug: string, formData: FormData): Promise<void> {
  const loaded = await load(slug)
  if (!loaded.ok) return
  await setViewPinned(
    loaded.collection,
    loaded.actor,
    String(formData.get('view_id') ?? '').trim(),
    String(formData.get('pinned') ?? '') === 'true',
  )
  revalidatePath(`/collections/${slug}`, 'layout')
}

export async function setViewNotifyAction(slug: string, formData: FormData): Promise<void> {
  const loaded = await load(slug)
  if (!loaded.ok) return
  await setViewNotify(
    loaded.collection,
    loaded.actor,
    String(formData.get('view_id') ?? '').trim(),
    String(formData.get('notify') ?? '') === 'on',
  )
  revalidatePath(`/collections/${slug}`, 'layout')
}
