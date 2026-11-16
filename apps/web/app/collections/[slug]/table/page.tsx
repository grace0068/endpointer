import Link from 'next/link'
import { notFound } from 'next/navigation'

import { validateViewDefinition, type ViewCondition } from '@endpointer/core'

import { CollectionTitle } from '@/components/collection-title'
import { EmptyState, UnavailableState } from '@/components/empty-state'
import { HeroBand } from '@/components/hero-band'
import { SaveViewForm } from '@/components/save-view-form'
import { TableSurface } from '@/components/table-surface'
import { Badge, Dot } from '@/components/ui/badge'
import { resolveCollectionAccess } from '@/lib/access'
import { getCollectionBySlug, listSites } from '@/lib/collections'
import { loadTablePage } from '@/lib/table-data'
import {
  hasQueryState,
  parseTableParams,
  sameColumns,
  sameQueryState,
  tableHref,
  type TableUrlState,
} from '@/lib/table-state'
import { cn } from '@/lib/utils'
import { listViews, summarizeView, type ViewRecord } from '@/lib/views'

import { createViewAction, updateViewAction } from '../view-actions'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * 표 탭 = 뷰 #0 (조건 없는 뷰 — 델타 2-3) · ADR A46·A47.
 *
 * 상태는 전부 주소에 있다. `?view=slug` 면 저장된 뷰를 그대로 보고(REST `?view=` 와 같은 함수),
 * 무엇이든 바꾸면 주소가 "그 뷰에서 바뀐 상태 + base=slug" 가 되어 덮어쓰기·새로 저장을 고를 수 있다.
 * 데이터는 언제나 서버가 전체 컬렉션에서 조회한 한 페이지다.
 */
export default async function CollectionDetailPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const rawParams = await searchParams

  const found = await getCollectionBySlug(slug)
  if (!found.ok) return <UnavailableState message={found.message} />
  if (found.data === null) notFound()
  const collection = found.data
  const fields = collection.schema_json

  // 주인·멤버가 아니면 없는 것과 같다 (ADR A40) — 존재 여부도 정보다
  const access = await resolveCollectionAccess(collection)
  if (!access.canView) notFound()

  const tablePath = `/collections/${collection.slug}/table`
  const [viewsResult, sites] = await Promise.all([listViews(collection), listSites(collection.id)])
  const views = viewsResult.ok ? viewsResult.data : []
  const hosts = sites.ok ? sites.data.map((s) => s.host) : []

  const title = <CollectionTitle name={collection.name} visibility={collection.visibility} />
  const parsed = parseTableParams(rawParams, fields)

  // ── 주소를 못 읽었다 — 더 넓은 표 대신 무엇이 문제인지 보인다 (A46) ──
  if (!parsed.ok) {
    return (
      <HeroBand dense overlap={false} title={title} sub="표">
        <ProblemCard
          heading="주소에 담긴 조건을 이해하지 못했어요"
          problems={parsed.problems}
          actions={[{ href: tablePath, label: '조건 없이 전체 보기' }]}
        />
      </HeroBand>
    )
  }

  const viewSlug = parsed.viewSlug
  const activeView: ViewRecord | null = viewSlug === null ? null : (views.find((v) => v.slug === viewSlug) ?? null)

  // ── 저장된 뷰를 보는 중인데 없거나 쓸 수 없다 ──────────────────────────
  if (viewSlug !== null && activeView === null) {
    return (
      <HeroBand dense overlap={false} title={title} sub="표">
        <ViewChips views={views} tablePath={tablePath} activeSlug={null} plain={false} />
        <ProblemCard
          heading={`‘${viewSlug}’ 라는 저장된 조건이 없어요`}
          problems={['이름이 바뀌었거나 지워졌을 수 있어요. 아래 목록에서 다시 골라 주세요.']}
          actions={[{ href: tablePath, label: '전체 보기' }]}
        />
      </HeroBand>
    )
  }
  if (activeView !== null && activeView.health === 'broken') {
    // 수정 경로 — 아직 맞는 조건만 남긴 상태로 표를 열고, 덮어쓰기를 고를 수 있게 한다.
    // 이건 **보여주기**가 아니라 고치기 시작점이다: 남긴 조건이 무엇인지 화면이 그대로 보인다
    const valid: ViewCondition[] = activeView.state.where.filter(
      (cond) => validateViewDefinition({ where: [cond], sort: [] }, fields).ok,
    )
    const sortOk = validateViewDefinition({ where: [], sort: activeView.state.sort }, fields).ok
    const sourceOk = activeView.state.source === null || hosts.includes(activeView.state.source)
    const fixState: TableUrlState = {
      where: valid,
      q: fields.some((f) => f.type === 'text') ? activeView.state.q : null,
      source: sourceOk ? activeView.state.source : null,
      sort: sortOk ? activeView.state.sort.slice(0, 1) : [],
      columns: activeView.columns,
      base: activeView.slug,
    }
    return (
      <HeroBand dense overlap={false} title={title} sub="표">
        <ViewChips views={views} tablePath={tablePath} activeSlug={activeView.slug} plain={false} />
        <ProblemCard
          heading={`‘${activeView.name}’ 은(는) 표 구성이 바뀌어 지금은 쓸 수 없어요`}
          problems={[
            ...activeView.problems,
            '조건을 빼고 더 넓게 보여드리지 않아요. 알림도 이 조건을 고칠 때까지 멈춰 있어요.',
          ]}
          actions={
            access.canManage
              ? [
                  { href: tableHref(tablePath, fixState, fields), label: '맞지 않는 조건을 빼고 표에서 고치기' },
                  { href: tablePath, label: '전체 보기' },
                ]
              : [{ href: tablePath, label: '전체 보기' }]
          }
          footnote={access.canManage ? undefined : '컬렉션 주인이 고칠 수 있어요.'}
        />
      </HeroBand>
    )
  }

  // ── 상태 정하기 ────────────────────────────────────────────────────────
  // 뷰를 보는 중이면 컨트롤은 "그 뷰의 상태 + base" — 무엇을 바꾸든 고치기 모드로 넘어간다
  const state: TableUrlState =
    activeView !== null
      ? { ...activeView.state, sort: activeView.state.sort.slice(0, 1), columns: activeView.columns, base: activeView.slug }
      : parsed.state
  const baseView = activeView === null && state.base !== null ? (views.find((v) => v.slug === state.base) ?? null) : null

  const load = await loadTablePage(
    collection,
    activeView !== null ? { viewSlug: activeView.slug, cursor: parsed.cursor } : { state, cursor: parsed.cursor },
  )

  // ── 저장 영역 — 주인만 (A47). 바뀐 게 있을 때만 보인다 ─────────────────
  const savable = { where: state.where, q: state.q, source: state.source, sort: state.sort, columns: state.columns }
  const changedFromBase =
    baseView !== null && (!sameQueryState(state, baseView.state) || !sameColumns(state.columns, baseView.columns))
  const freshState = activeView === null && baseView === null && (hasQueryState(state) || state.columns !== null)
  const summary = summarizeView({ state }, fields)

  return (
    <HeroBand dense overlap={false} title={title} sub="표">
      <div className="flex flex-col gap-4">
        <ViewChips
          views={views}
          tablePath={tablePath}
          activeSlug={activeView?.slug ?? baseView?.slug ?? null}
          plain={activeView === null && baseView === null && !hasQueryState(state)}
        />

        {activeView !== null && (
          <p className="text-[13px] text-muted">
            <Badge tone="accent" className="mr-1.5 font-bold">
              {activeView.name}
            </Badge>
            {summary === '' ? '조건 없이 전체를 봐요' : `조건: ${summary}`}
            {activeView.droppedColumns.length > 0 && (
              <span className="ml-2 text-faint">· 저장된 열 중 표에서 사라진 것은 빼고 보여드려요</span>
            )}
            {access.canManage && <span className="ml-2 text-faint">· 아래에서 무엇이든 바꾸면 이 조건을 고칠 수 있어요</span>}
          </p>
        )}

        {baseView !== null && (
          <p className="text-[13px] text-muted">
            <Badge tone="accent" className="mr-1.5 font-bold">
              {baseView.name}
            </Badge>
            {changedFromBase ? '에서 바꾼 상태예요' : '과(와) 같은 상태예요'}
            <Link href={`${tablePath}?view=${baseView.slug}`} className="ml-2 text-faint hover:text-accent">
              되돌리기
            </Link>
          </p>
        )}

        {access.canManage && (changedFromBase || freshState) && (
          <SaveViewForm
            stateJson={JSON.stringify(savable)}
            suggestedName={summary.slice(0, 60) || '내 조건'}
            create={createViewAction.bind(null, collection.slug)}
            {...(changedFromBase && baseView !== null
              ? { update: { viewSlug: baseView.slug, viewName: baseView.name, save: updateViewAction.bind(null, collection.slug) } }
              : {})}
          />
        )}
        {!access.canManage && (changedFromBase || freshState) && (
          <p className="text-xs text-faint">읽기 전용으로 함께 보는 중이라 지금 조건은 이 화면에서만 쓰여요. 저장은 컬렉션 주인이 할 수 있어요.</p>
        )}

        {!load.ok ? (
          load.kind === 'unavailable' ? (
            <UnavailableState message={load.message} />
          ) : (
            <ProblemCard
              heading="이 조건으로는 볼 수 없어요"
              problems={load.problems.length > 0 ? load.problems : [load.message]}
              actions={[{ href: tablePath, label: '조건 없이 전체 보기' }]}
            />
          )
        ) : load.response.page.total === 0 && !hasQueryState(state) ? (
          <EmptyState
            title="아직 이 표에 담긴 항목이 없어요"
            body="사이트를 하나 더 붙이면 같은 표에 같은 형식으로 담깁니다."
          />
        ) : (
          <TableSurface
            basePath={tablePath}
            fields={fields}
            hosts={hosts}
            state={state}
            load={load}
            linkMode={activeView !== null ? { kind: 'view', slug: activeView.slug } : { kind: 'state' }}
            cursor={parsed.cursor}
            emptyText="이 조건에 맞는 항목이 지금은 없어요. 조건을 넓히거나, 저장해 두면 새로 생길 때 알 수 있어요."
          />
        )}
      </div>
    </HeroBand>
  )
}

/** 뷰 칩 — 전체(뷰 #0) + 저장된 뷰들 */
function ViewChips({
  views,
  tablePath,
  activeSlug,
  plain,
}: {
  views: readonly ViewRecord[]
  tablePath: string
  activeSlug: string | null
  /** 조건 없는 전체를 보는 중 */
  plain: boolean
}) {
  if (views.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={tablePath}
        className={cn(
          'rounded-full border px-3.5 py-1.5 text-[13px] font-bold hover:no-underline',
          plain ? 'border-accent bg-accent text-accent-ink' : 'border-border bg-surface text-muted hover:border-accent hover:text-accent',
        )}
      >
        전체
      </Link>
      {views.map((view) => (
        <Link
          key={view.id}
          href={`${tablePath}?view=${view.slug}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-bold hover:no-underline',
            activeSlug === view.slug
              ? 'border-accent bg-accent text-accent-ink'
              : 'border-border bg-surface text-muted hover:border-accent hover:text-accent',
          )}
        >
          {view.health !== 'ok' && <Dot className="bg-attention" />}
          {view.pinned && <span aria-hidden>★</span>}
          {view.name}
        </Link>
      ))}
    </div>
  )
}

/** 조건·뷰 문제 — 원인과 다음에 할 일 (B4: 코드·내부 명사 없이) */
function ProblemCard({
  heading,
  problems,
  actions,
  footnote,
}: {
  heading: string
  problems: readonly string[]
  actions: readonly { href: string; label: string }[]
  footnote?: string | undefined
}) {
  return (
    <section className="rounded-card border border-attention/30 bg-surface p-5">
      <h2 className="mb-2 text-[15px] font-semibold text-ink">{heading}</h2>
      <ul className="mb-3 flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-muted">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3 text-[13px]">
        {actions.map((a) => (
          <Link key={a.href + a.label} href={a.href} className="font-semibold text-accent">
            {a.label}
          </Link>
        ))}
      </div>
      {footnote !== undefined && <p className="mt-2 text-xs text-faint">{footnote}</p>}
    </section>
  )
}

