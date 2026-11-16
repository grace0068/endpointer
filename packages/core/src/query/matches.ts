// 뷰의 매칭 집합 — 워커 평가와 기준선이 같이 부르는 하나의 코드 (ADR A52)
//
//   [저장된 뷰] ─parseStoredView─ [조회 상태] ─viewToQuery─ [쿼리] ─buildItemsWhere─ [지금 맞는 항목]
//
// 표·REST·MCP 가 타는 바로 그 판정이다. 여기서 조건을 따로 해석하면 "표에서 보이는 것과
// 알림이 오는 것이 다르다" 가 된다.
//
// ── 기준선 (A52) ────────────────────────────────────────────────────────
// 뷰를 만들 때 · 조회 상태를 덮어쓸 때 · 알림을 켤 때 `view_matches` 를 지금 집합으로 맞춘다.
// 그래야 다음 평가의 차집합(enter)이 "그 뒤에 들어온 것" 만 된다. 기준선은 사건이 아니다 —
// 발송하지 않고 notification_log 에도 남기지 않는다.

import { and, eq, notInArray } from 'drizzle-orm'

import type { Db } from '../db/client'
import { collections, items, viewMatches, views } from '../db/schema'
import type { CollectionSchemaJson } from '../types/collection'
import { buildItemsWhere } from './build'
import { hostMatches, loadSourceStates, type SourceStateLike } from './respond'
import { parseStoredView, type StoredViewRow } from './resolve'
import { viewToQuery } from './view'

/**
 * 지금 이 뷰에 맞는 항목 id. 뷰가 표 구성과 안 맞으면(broken, A47) **null** —
 * 사라진 칸 조건을 빼고 세면 더 넓게 매칭되므로 세지 않는다.
 */
export async function currentViewMatchIds(
  db: Db,
  collectionId: string,
  view: StoredViewRow,
  fields: CollectionSchemaJson,
  sourceRows: readonly SourceStateLike[],
  now: Date,
): Promise<Set<string> | null> {
  const hosts = [...new Set(sourceRows.map((s) => s.host))]
  const stored = parseStoredView(view, fields, hosts)
  if (stored.health === 'broken') return null

  const query = viewToQuery(stored.state, now)
  const sourceIds =
    query.source === undefined
      ? null
      : sourceRows.filter((s) => hostMatches(s.host, query.source as string)).map((s) => s.id)
  const where = buildItemsWhere(query, { collectionId, fields, sourceIds })
  const rows = await db.select({ id: items.id }).from(items).where(where)
  return new Set(rows.map((r) => r.id))
}

export type BaselineResult =
  | { ok: true; matched: number }
  /** 뷰가 없거나(지워짐·다른 컬렉션) 표 구성과 안 맞는다 — 기준선을 잡지 않았다 */
  | { ok: false; reason: 'not_found' | 'broken' }

/**
 * 뷰의 매칭 기록을 지금 집합으로 맞춘다 — 발송하지 않는다 (A52).
 * 이미 기록에 있는 항목은 matched_at 을 건드리지 않는다(진입 시각은 그대로).
 */
export async function baselineViewMatches(
  db: Db,
  collectionId: string,
  viewId: string,
  now: Date = new Date(),
): Promise<BaselineResult> {
  const viewRows = await db
    .select()
    .from(views)
    .where(and(eq(views.id, viewId), eq(views.collection_id, collectionId)))
    .limit(1)
  const view = viewRows[0]
  if (view === undefined) return { ok: false, reason: 'not_found' }

  const colRows = await db
    .select({ schema_json: collections.schema_json })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1)
  const fields = colRows[0]?.schema_json
  if (fields === undefined) return { ok: false, reason: 'not_found' }

  const sourceRows = await loadSourceStates(db, collectionId)
  const current = await currentViewMatchIds(db, collectionId, view as StoredViewRow, fields, sourceRows, now)
  if (current === null) return { ok: false, reason: 'broken' }

  const ids = [...current]
  await db.transaction(async (tx) => {
    await tx
      .delete(viewMatches)
      .where(ids.length === 0 ? eq(viewMatches.view_id, viewId) : and(eq(viewMatches.view_id, viewId), notInArray(viewMatches.item_id, ids)))
    if (ids.length > 0) {
      await tx
        .insert(viewMatches)
        .values(ids.map((item_id) => ({ view_id: viewId, item_id, matched_at: now })))
        .onConflictDoNothing()
    }
  })
  return { ok: true, matched: ids.length }
}

/** 이 컬렉션의 뷰 하나를 slug 로 찾아 기준선을 잡는다 — 화면이 저장 직후 부른다 */
export async function baselineViewMatchesBySlug(
  db: Db,
  collectionId: string,
  slug: string,
  now: Date = new Date(),
): Promise<BaselineResult> {
  const rows = await db
    .select({ id: views.id })
    .from(views)
    .where(and(eq(views.collection_id, collectionId), eq(views.slug, slug)))
    .limit(1)
  const id = rows[0]?.id
  return id === undefined ? { ok: false, reason: 'not_found' } : baselineViewMatches(db, collectionId, id, now)
}
