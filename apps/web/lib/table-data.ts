// 표 한 페이지 — 표·모두의 컬렉션 상세가 같이 쓴다 (ADR A46).
//
// 서버가 **전체 컬렉션**을 대상으로 조회한다 — 검색·출처·정렬·페이지가 전부 core 의
// runCollectionRequest 하나이고, 그건 REST·MCP 가 타는 바로 그 함수다. 브라우저에 200개를
// 내려보내 거르던 방식은 없앴다 (201번째부터는 검색에도 정렬에도 안 잡혔다).

import type { CollectionResponse, CollectionSchemaJson } from '@endpointer/core'
import { runCollectionRequest, type StoredView } from '@endpointer/core/query'

import { loadCore, STORAGE_UNAVAILABLE } from './db'
import type { TableState } from './table-state'

/** 한 페이지 크기 — 화면이 한 번에 그리는 행 수 */
export const TABLE_PAGE_SIZE = 50

export type TableLoad =
  | {
      ok: true
      response: CollectionResponse
      /** 사람에게 알릴 것 (예: 조건이 바뀌어 처음부터 보여준다) */
      notice: string | null
      view: StoredView | null
    }
  | {
      ok: false
      /** problem = 조건·뷰 문제(사용자가 고칠 수 있다), unavailable = 저장소 문제 */
      kind: 'problem' | 'unavailable'
      message: string
      problems: string[]
      view: StoredView | null
    }

export interface TableLoadInput {
  /** 저장된 뷰 보기 (`?view=`) */
  viewSlug?: string | null
  /** 지금 조건 (뷰를 고치는 중이거나 임시 조건) */
  state?: TableState | null
  cursor: string | null
  /** 원문 대조 툴팁용 */
  includeProvenance?: boolean
  /** 상대 날짜 기준 시각 — 테스트가 고정한다. 없으면 지금 */
  now?: Date
}

export async function loadTablePage(
  collection: { id: string; schema_json: CollectionSchemaJson; schema_version: number },
  input: TableLoadInput,
): Promise<TableLoad> {
  const core = await loadCore()
  if (core === null) return { ok: false, kind: 'unavailable', message: STORAGE_UNAVAILABLE, problems: [], view: null }

  const base =
    input.state === undefined || input.state === null
      ? null
      : { where: input.state.where, sort: input.state.sort, q: input.state.q, source: input.state.source }

  const params = (cursor: string | null): Record<string, string> => ({
    limit: String(TABLE_PAGE_SIZE),
    ...(input.includeProvenance === false ? {} : { include: 'provenance' }),
    ...(cursor !== null ? { cursor } : {}),
  })

  try {
    let outcome = await runCollectionRequest(core.db, collection, {
      params: params(input.cursor),
      viewSlug: input.viewSlug ?? null,
      base,
      ...(input.now !== undefined ? { now: input.now } : {}),
    })
    let notice: string | null = null

    // 화면에서는 옛 커서를 만나면 같은 조건의 **첫 페이지**로 — 조건을 넓히는 게 아니라 위치만 처음으로 (A46)
    if (!outcome.ok && outcome.code === 'invalid_cursor' && input.cursor !== null) {
      outcome = await runCollectionRequest(core.db, collection, {
        params: params(null),
        viewSlug: input.viewSlug ?? null,
        base,
        ...(input.now !== undefined ? { now: input.now } : {}),
      })
      notice = '조건이나 정렬이 바뀌어서 처음부터 보여드려요.'
    }

    if (!outcome.ok) {
      return {
        ok: false,
        kind: 'problem',
        message: outcome.message,
        problems: outcome.problems.map((p) => p.message),
        view: outcome.view,
      }
    }
    return { ok: true, response: outcome.response, notice, view: outcome.view }
  } catch (cause) {
    console.warn('[endpointer/web] 표를 불러오지 못했습니다', cause)
    return { ok: false, kind: 'unavailable', message: STORAGE_UNAVAILABLE, problems: [], view: null }
  }
}
