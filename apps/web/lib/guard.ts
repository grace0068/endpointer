// 서버 액션의 공통 관문 — slug → 컬렉션 → 행위자 → 주인인가 (ADR A49).
// 화면이 버튼을 숨겨도 서버 액션은 누구나 부를 수 있다. 바꾸는 액션은 전부 여기를 지난다.

import { currentActor, requireManager, type Actor } from './access'
import { getCollectionBySlug, type CollectionRecord } from './collections'

export type ManagedCollection =
  | { ok: true; collection: CollectionRecord; actor: Actor }
  | { ok: false; message: string }

export async function managedCollection(slug: string): Promise<ManagedCollection> {
  const found = await getCollectionBySlug(slug)
  if (!found.ok) return { ok: false, message: found.message }
  if (found.data === null) return { ok: false, message: '이 컬렉션을 찾지 못했어요. 화면을 새로 고쳐 주세요.' }
  const actor = await currentActor()
  const guard = await requireManager(found.data, actor)
  if (!guard.ok) return guard
  return { ok: true, collection: found.data, actor }
}
