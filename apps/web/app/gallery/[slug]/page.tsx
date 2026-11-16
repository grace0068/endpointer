import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CloneButton } from '@/components/clone-button'
import { TableSurface } from '@/components/table-surface'
import { EmptyState, UnavailableState } from '@/components/empty-state'
import { HeroBand } from '@/components/hero-band'
import { HostChip } from '@/components/ui/host-chip'
import { Icon } from '@/components/ui/icon'
import { getCollectionBySlug, listSites } from '@/lib/collections'
import { galleryMetaFor } from '@/lib/gallery'
import { loadTablePage } from '@/lib/table-data'
import { parseTableParams } from '@/lib/table-state'

import { cloneCollectionAction } from '../actions'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** 검색·출처·정렬·페이지는 표 탭과 같이 서버가 전체 컬렉션에서 조회한다 (ADR A46). 조건 필터·뷰 저장은 없다 */
const GALLERY_PARAMS = new Set(['q', 'source', 'sort', 'cursor'])

/**
 * 모두의 컬렉션 공개 상세 (델타 §8). **로그인 없이** 표를 읽기 전용으로 보고, 복제할지 정한다.
 * 소유자 전용 access(resolveCollectionAccess)를 타지 않는다 — 여기서는 visibility='public'
 * 자체가 열쇠다. 공개가 아니면 없는 것과 같다.
 */
export default async function GalleryDetailPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const rawParams = await searchParams

  const found = await getCollectionBySlug(slug)
  if (!found.ok) return <UnavailableState message={found.message} />
  if (found.data === null) notFound()

  const collection = found.data
  // 공개만 모두의 컬렉션에서 열린다. private·unlisted 는 존재 여부도 드러내지 않는다.
  if (collection.visibility !== 'public') notFound()

  // 모두의 컬렉션 상세는 검색·출처·정렬만 받는다 — 그 밖의 파라미터는 문제로 (A46)
  const allowed = Object.fromEntries(Object.entries(rawParams).filter(([name]) => GALLERY_PARAMS.has(name)))
  const unknown = Object.keys(rawParams).filter((name) => !GALLERY_PARAMS.has(name))
  const parsed = parseTableParams(allowed, collection.schema_json)
  const state = parsed.ok ? parsed.state : null
  const cursor = parsed.ok ? parsed.cursor : null

  const [page, sites, meta] = await Promise.all([
    state !== null && unknown.length === 0
      ? loadTablePage(collection, { state, cursor })
      : Promise.resolve(null),
    listSites(collection.id),
    galleryMetaFor(collection.id),
  ])

  const siteList = sites.ok ? sites.data : []
  const basePath = `/gallery/${collection.slug}`
  const author = meta.ok ? meta.data.author : '익명'
  const forkCount = meta.ok ? meta.data.fork_count : 0

  return (
    <HeroBand
      dense
      overlap={false}
      title={<h1 className="text-[22px] font-bold tracking-[-0.03em] text-white">{collection.name}</h1>}
      sub={`${author} 님이 만듦${forkCount > 0 ? ` · 복제 ${forkCount}회` : ''}`}
      action={
        <CloneButton
          clone={cloneCollectionAction.bind(null, collection.slug)}
          variant="primary"
          size="md"
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Link
          href="/gallery"
          className="inline-flex w-fit items-center gap-1.5 text-[13px] text-faint hover:text-accent hover:no-underline"
        >
          <Icon name="chevron-left" size={13} strokeWidth={2} /> 모두의 컬렉션으로
        </Link>

        {siteList.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-faint">사이트</span>
            {siteList.map((site) => (
              <HostChip key={site.id} host={site.host} />
            ))}
          </div>
        )}

        {/* 복제하면 이 표가 그대로 내 것이 되고, 여기에 내 사이트를 더할 수 있다 */}
        <p className="rounded-card border border-accent-soft bg-accent-soft/40 px-4 py-3 text-[13px] text-ink">
          이 표를 <b className="font-semibold">복제</b>하면 사이트·뷰가 그대로 내 컬렉션으로 들어와요.
          거기에 내가 아는 사이트를 더하면 나만의 카테고리가 됩니다.
        </p>

        {page === null || state === null ? (
          <p className="rounded-card border border-attention/30 bg-surface px-4 py-4 text-sm text-muted">
            주소에 담긴 조건을 이해하지 못했어요.{' '}
            <Link href={basePath} className="font-semibold text-accent">
              조건 없이 보기
            </Link>
          </p>
        ) : !page.ok ? (
          <UnavailableState message={page.message} />
        ) : page.response.page.total === 0 && state.q === null && state.source === null ? (
          <EmptyState
            title="아직 이 표에 담긴 항목이 없어요"
            body="복제한 뒤 사이트를 붙이면 같은 표에 같은 형식으로 담깁니다."
          />
        ) : (
          <TableSurface
            basePath={basePath}
            fields={collection.schema_json}
            hosts={siteList.map((site) => site.host)}
            state={state}
            load={page}
            linkMode={{ kind: 'state' }}
            cursor={cursor}
            filterMode="basic"
            columnsEditable={false}
            emptyText="찾는 조건에 맞는 항목이 없어요. 검색어를 지우거나 출처를 전체로 바꿔보세요."
          />
        )}
      </div>
    </HeroBand>
  )
}
