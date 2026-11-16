// 표 한 화면 — 필터 바 · 결과 범위 · 표 · 페이지 이동 (ADR A46). 표 탭과 모두의 컬렉션 상세가 같이 쓴다.
//
// 데이터는 서버가 전체 컬렉션을 대상으로 조회한 **한 페이지**다 (lib/table-data). 이 화면이 하는 일은
// 그 결과가 "전체 중 어디인지" 와 "더 있는지" 를 보이고, 다음 상태로 가는 주소를 만드는 것뿐이다.
// 조건·정렬이 바뀌는 주소에는 커서를 싣지 않는다(처음부터), 페이지·열 주소에만 싣는다.

import Link from 'next/link'

import { SOURCE_COLUMN_ID, summarizeViewCondition, type FieldDef, type ViewCondition } from '@endpointer/core'

import { CollectionTable, type SortLink } from '@/components/collection-table'
import { FilterBar } from '@/components/filter-bar'
import type { TableLoad } from '@/lib/table-data'
import { conditionsToParams, defaultColumnOrder, tableHref, type TableUrlState } from '@/lib/table-state'

export type TableLinkMode = { kind: 'view'; slug: string } | { kind: 'state' }

export interface TableSurfaceProps {
  basePath: string
  fields: readonly FieldDef[]
  hosts: readonly string[]
  /** 컨트롤이 그릴 지금 상태. 뷰를 보는 중이면 그 뷰의 상태에 base=slug */
  state: TableUrlState
  load: Extract<TableLoad, { ok: true }>
  /** 페이지 이동 주소를 저장된 뷰 주소(?view=)로 낼지, 상태 주소로 낼지 */
  linkMode: TableLinkMode
  /** 지금 커서 (열 바꾸기가 페이지를 유지하는 데 쓴다) */
  cursor: string | null
  filterMode?: 'full' | 'basic'
  columnsEditable?: boolean
  /** 결과가 0건일 때 보일 문장 */
  emptyText: string
}

const numberFormat = new Intl.NumberFormat('ko-KR')

export function TableSurface(props: TableSurfaceProps) {
  const { basePath, fields, state, load, linkMode } = props
  const { items, page } = load.response
  const defaults = defaultColumnOrder(fields)
  const columns = state.columns ?? defaults

  // 정렬 링크 — 없음 → 오름 → 내림 → 없음(기본: 새로 올라온 순). 조건이 바뀌니 커서 없이
  const current = state.sort[0]
  const sortLinks: Record<string, SortLink> = {}
  for (const id of columns) {
    if (id === SOURCE_COLUMN_ID) continue
    const dir = current?.field === id ? current.dir : null
    const nextSort = dir === null ? [{ field: id, dir: 'asc' as const }] : dir === 'asc' ? [{ field: id, dir: 'desc' as const }] : []
    sortLinks[id] = { href: tableHref(basePath, { ...state, sort: nextSort }, fields), dir }
  }

  // 열 바꾸기 주소 — 결과가 안 바뀌므로 커서를 유지한다
  const colsHrefBase =
    props.columnsEditable === false ? null : tableHref(basePath, { ...state, columns: null }, fields, { cursor: props.cursor })

  const pageHref = (cursor: string | null) =>
    linkMode.kind === 'view'
      ? `${basePath}?view=${encodeURIComponent(linkMode.slug)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      : tableHref(basePath, state, fields, { cursor })

  // 필터 바에 칸이 없는 조건 — 칩으로 보이고, 하나씩 뺄 수 있다 (조용히 숨기지 않는다)
  const { extra } = conditionsToParams(state.where, fields)
  const removeHref = (cond: ViewCondition) =>
    tableHref(basePath, { ...state, where: state.where.filter((c) => c !== cond) }, fields)

  const from = items.length === 0 ? 0 : page.offset + 1
  const to = page.offset + items.length

  return (
    <div className="flex flex-col gap-3">
      <FilterBar basePath={basePath} fields={fields} state={state} hosts={props.hosts} mode={props.filterMode ?? 'full'} />

      {extra.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <span className="text-faint">그 밖의 조건</span>
          {extra.map((cond, i) => (
            <span key={`${cond.field}-${cond.op}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-raised px-3 py-1">
              {summarizeViewCondition(cond, fields)}
              <Link href={removeHref(cond)} aria-label="이 조건 빼기" className="text-faint hover:text-attention hover:no-underline">
                ×
              </Link>
            </span>
          ))}
        </div>
      )}

      {load.notice !== null && (
        <p className="rounded-lg border border-border bg-raised px-3 py-2 text-[13px] text-muted">{load.notice}</p>
      )}

      {/* 결과의 범위 — 지금 보는 게 전체 중 어디인지, 더 있는지 (A46) */}
      <p className="text-[13px] text-muted" aria-live="polite">
        {page.total === 0 ? (
          '조건에 맞는 항목이 없어요'
        ) : (
          <>
            전체 <b className="text-ink">{numberFormat.format(page.total)}</b>개 중{' '}
            <b className="text-ink">
              {numberFormat.format(from)}–{numberFormat.format(to)}
            </b>
            번째
            {page.next_cursor !== null ? ' · 뒤에 더 있어요' : page.offset > 0 ? ' · 마지막 페이지예요' : ''}
          </>
        )}
      </p>

      {items.length === 0 ? (
        <p className="rounded-card border border-border bg-raised px-4 py-4 text-sm text-muted">{props.emptyText}</p>
      ) : (
        <CollectionTable
          key={columns.join(',')}
          fields={fields}
          items={items}
          columns={columns}
          defaultColumns={defaults}
          sortLinks={sortLinks}
          colsHrefBase={colsHrefBase}
        />
      )}

      {(page.offset > 0 || page.next_cursor !== null) && (
        <nav aria-label="페이지" className="flex items-center gap-3 text-[13px]">
          {page.offset > 0 && (
            <Link href={pageHref(null)} className="text-muted hover:text-accent">
              ← 처음으로
            </Link>
          )}
          {page.next_cursor !== null && (
            <Link
              href={pageHref(page.next_cursor)}
              className="ml-auto rounded-lg border border-border bg-surface px-3.5 py-1.5 font-semibold text-ink hover:border-accent hover:text-accent hover:no-underline"
            >
              다음 {numberFormat.format(Math.min(page.limit, page.total - to))}개 →
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
