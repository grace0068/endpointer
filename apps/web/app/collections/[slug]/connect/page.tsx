import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ApiKeyManage } from '@/components/api-key-manage'
import { CollectionTitle } from '@/components/collection-title'
import { CopyButton } from '@/components/copy-button'
import { DeveloperDetails } from '@/components/developer-details'
import { UnavailableState } from '@/components/empty-state'
import { HeroBand } from '@/components/hero-band'
import { resolveCollectionAccess } from '@/lib/access'
import { getApiKeyStatus } from '@/lib/api-keys'
import { fetchCollectionPage, getCollectionBySlug } from '@/lib/collections'
import { COPY } from '@/lib/labels'
import { apiUrlFor, mcpUrlFor } from '@/lib/urls'

import { issueApiKeyAction, revokeApiKeyAction } from '../key-actions'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
}

const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' })

/** 공개 범위 → 바깥(REST·AI)에서 실제로 어떻게 열리는가 (A49 — 실제 판정과 같은 말) */
const ACCESS_COPY = {
  private: {
    label: '비공개',
    rule: 'API 키가 있어야 열려요. 키는 요청 헤더에 넣어 보내요 — 주소에 넣지 않아요.',
  },
  unlisted: {
    label: '주소를 아는 사람',
    rule: '키 없이 열려요. 주소(컬렉션 이름)를 아는 사람은 누구나 항목을 읽을 수 있어요.',
  },
  public: {
    label: '전체공개',
    rule: '키 없이 누구나 열 수 있어요. 모두의 컬렉션 상세 화면에서도 읽을 수 있어요.',
  },
} as const

/**
 * 연결 탭 (ADR A48·A49). 주인공은 AI 연결(MCP)과 REST API — 둘 다 같은 조회 함수를 탄다.
 * 맨 위에 "이 컬렉션은 바깥에서 어떻게 열리나" 를 먼저 말한다 — 키가 필요한지 모르면 예시가 쓸모없다.
 */
export default async function CollectionConnectPage({ params }: PageProps) {
  const { slug } = await params

  const found = await getCollectionBySlug(slug)
  if (!found.ok) return <UnavailableState message={found.message} />
  if (found.data === null) notFound()
  const collection = found.data

  // 주인·멤버가 아니면 없는 것과 같다 (ADR A40)
  const access = await resolveCollectionAccess(collection)
  if (!access.canView) notFound()

  const isPrivate = collection.visibility === 'private'
  const copy = ACCESS_COPY[collection.visibility]
  const mcpUrl = mcpUrlFor(collection.slug)
  // 키 상태는 주인에게만 — 멤버에게는 앞 글자도 보이지 않는다 (A48)
  const keyStatus = access.canManage ? await getApiKeyStatus(collection.id) : null

  // 응답 JSON 샘플 — 지어내지 않고 실제로 2건 조회해 그 형태를 보여준다 (없으면 그 탭을 숨긴다)
  const samplePage = await fetchCollectionPage(collection, 'limit=2')
  const sampleJson =
    samplePage.ok && samplePage.data.items.length > 0 ? JSON.stringify(samplePage.data, null, 2) : null

  return (
    <HeroBand
      dense
      overlap={false}
      title={<CollectionTitle name={collection.name} visibility={collection.visibility} />}
      sub="연결"
    >
      <div className="flex flex-col gap-4">
        {/* 바깥에서 어떻게 열리나 — 키가 필요한지가 먼저다 */}
        <section className="rounded-card border border-border bg-surface px-6 py-4">
          <p className="text-[13.5px] text-ink">
            공개범위 <b>{copy.label}</b> — {copy.rule}
          </p>
          {isPrivate && !access.canManage && (
            <p className="mt-1 text-[13px] text-muted">
              키는 컬렉션 주인만 만들 수 있어요. 함께 보는 사람은 주인에게 키를 받아 써야 해요.
            </p>
          )}
          {access.canManage && (
            <p className="mt-1 text-[12.5px] text-faint">
              공개범위는{' '}
              <Link href={`/collections/${collection.slug}/settings`} className="text-accent">
                설정
              </Link>
              에서 바꿔요.
            </p>
          )}
        </section>

        {keyStatus !== null && (
          <ApiKeyManage
            active={keyStatus.ok && keyStatus.data.active}
            hint={keyStatus.ok ? keyStatus.data.hint : null}
            createdLabel={keyStatus.ok && keyStatus.data.createdAt !== null ? DATE_FORMAT.format(keyStatus.data.createdAt) : null}
            isPrivate={isPrivate}
            issue={issueApiKeyAction.bind(null, collection.slug)}
            revoke={revokeApiKeyAction.bind(null, collection.slug)}
          />
        )}

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section className="rounded-card border border-border bg-surface p-7">
            <h2 className="mb-1 text-base font-bold text-ink">{COPY.connectTitle}</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-faint">{COPY.connectBody}</p>

            <div className="mb-4 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[9px] border border-border bg-canvas px-3.5 py-2.5 font-mono text-[12.5px] text-muted">
                {mcpUrl}
              </code>
              <CopyButton value={mcpUrl} label={COPY.copy} />
            </div>

            {isPrivate ? (
              // 비공개 — 키를 주소에 싣지 않는다 (A48). 헤더를 받는 커넥터에서 연결한다
              <div className="mb-6 flex flex-col gap-2 text-[13.5px] text-muted">
                <p>비공개 컬렉션은 커넥터의 <b>헤더</b> 칸에 아래 한 줄을 넣어 연결해요.</p>
                <code className="rounded-[9px] border border-border bg-canvas px-3.5 py-2.5 font-mono text-[12.5px]">
                  Authorization: Bearer &lt;API 키&gt;
                </code>
                <p className="text-xs text-faint">
                  주소 칸 하나만 있는 앱이라면 공개범위를 ‘주소를 아는 사람’으로 두면 주소만으로 연결돼요.
                </p>
              </div>
            ) : (
              <ol className="mb-6 flex flex-col gap-2.5">
                {[COPY.connectStep1, COPY.connectStep2, COPY.connectStep3].map((step, index) => (
                  <li key={step} className="flex items-center gap-2.5 text-[13.5px] text-muted">
                    <span
                      aria-hidden
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-extrabold text-brand"
                    >
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            )}
            {collection.visibility === 'unlisted' && (
              <p className="mb-4 text-xs text-faint">이 주소를 아는 사람은 누구나 볼 수 있어요. 공개해도 괜찮은 내용인지 한 번만 확인해 주세요.</p>
            )}

            {/* 붙여넣고 나면 이런 대화가 된다 — 장식이 아니라 사용법 안내다 */}
            <div className="flex flex-col gap-2.5 rounded-xl bg-canvas p-4 text-[13.5px]">
              <p className="max-w-[85%] self-end rounded-[13px] rounded-br-[3px] bg-accent px-4 py-2.5 text-accent-ink">
                이 컬렉션에서 이번 주 마감 뭐 있어?
              </p>
              <p className="max-w-[90%] self-start rounded-[13px] rounded-bl-[3px] border border-border bg-surface px-4 py-3 leading-relaxed">
                컬렉션에 담긴 항목을 바로 읽고, 마감이 가까운 것부터 알려드려요. 저장한 조건도 각각 도구로 나와요.
              </p>
            </div>
          </section>

          <DeveloperDetails
            apiUrl={apiUrlFor(collection.slug)}
            fields={collection.schema_json}
            sampleJson={sampleJson}
            requiresKey={isPrivate}
          />
        </div>
      </div>
    </HeroBand>
  )
}
