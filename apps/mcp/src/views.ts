// 저장된 뷰 로딩 — 뷰마다 MCP 도구 하나가 된다 (뷰 계약 §4 · 델타 2-4).
//
// 읽기·판정은 core 의 loadStoredViews 다 — REST `?view=` 와 웹 표가 같은 판정을 본다 (A47).
// 이 서버는 stateless 라 요청마다 다시 읽는다 (app.ts 머리말) — 화면에서 뷰를 만들면
// **다음 요청부터 도구가 자동으로 생긴다.** 캐싱하지 않는 이유다.

import type { Db } from '@endpointer/core/db'
import type { FieldDef } from '@endpointer/core'
import { loadSourceStates, loadStoredViews, type StoredView } from '@endpointer/core/query'

export async function loadViewsForMcp(
  db: Db,
  collectionId: string,
  fields: readonly FieldDef[],
): Promise<StoredView[]> {
  const sources = await loadSourceStates(db, collectionId)
  return loadStoredViews(db, collectionId, fields, [...new Set(sources.map((s) => s.host))])
}
