// 테스트 데이터 만들기 (ADR A50). 테스트마다 **새 컬렉션**을 만들어 격리한다.
//
// test-db 를 먼저 import 해야 한다 — 그래야 아래 db 클라이언트가 테스트 DB 로 붙는다.
import './test-db'

import { randomUUID } from 'node:crypto'

import { queryClient } from '../db/client'
import type { CollectionSchemaJson, Visibility } from '../types/collection'
import type { ItemData } from '../types/item'

/** 겹치지 않는 짧은 꼬리표 — slug·호스트를 테스트마다 다르게 만든다 */
export function uniqueTag(prefix = 't'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export async function createTestUser(name = '테스트 사용자'): Promise<string> {
  const id = randomUUID()
  await queryClient`insert into users (id, name, email) values (${id}, ${name}, ${`${id}@test.local`})`
  return id
}

export interface TestCollectionInput {
  ownerId: string
  schema: CollectionSchemaJson
  visibility?: Visibility
  slug?: string
  name?: string
  apiKeyHash?: string | null
  listed?: boolean
}

export interface TestCollection {
  id: string
  slug: string
  owner_id: string
  name: string
  schema_json: CollectionSchemaJson
  schema_version: number
  visibility: Visibility
  api_key_hash: string | null
}

export async function createTestCollection(input: TestCollectionInput): Promise<TestCollection> {
  const slug = input.slug ?? uniqueTag('col')
  const name = input.name ?? `테스트 ${slug}`
  const visibility = input.visibility ?? 'unlisted'
  const rows = await queryClient<{ id: string }[]>`
    insert into collections (owner_id, slug, name, schema_json, visibility, api_key_hash, listed)
    values (${input.ownerId}, ${slug}, ${name}, ${JSON.stringify(input.schema)}::jsonb, ${visibility},
            ${input.apiKeyHash ?? null}, ${input.listed ?? false})
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) throw new Error('컬렉션을 만들지 못했다')
  return {
    id,
    slug,
    owner_id: input.ownerId,
    name,
    schema_json: input.schema,
    schema_version: 1,
    visibility,
    api_key_hash: input.apiKeyHash ?? null,
  }
}

export async function createTestSource(
  collectionId: string,
  host: string,
  opts: { status?: 'ok' | 'healing' | 'needs_attention' | 'paused'; entryUrl?: string; fetchMode?: string } = {},
): Promise<string> {
  const rows = await queryClient<{ id: string }[]>`
    insert into sources (collection_id, host, entry_url, status, fetch_mode, last_ok_at)
    values (${collectionId}, ${host}, ${opts.entryUrl ?? `https://${host}/list`}, ${opts.status ?? 'ok'},
            ${opts.fetchMode ?? 'html'}, now())
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) throw new Error('출처를 만들지 못했다')
  return id
}

export interface TestItemInput {
  data: ItemData
  /** 주지 않으면 한 트랜잭션의 now() — 실제 수집처럼 같은 마이크로초가 된다 */
  firstSeenAt?: Date
  externalKey?: string
}

/**
 * 항목을 한 번에 넣는다. **한 문장(한 트랜잭션)** 이라 firstSeenAt 을 안 주면 전부 같은 now() 다 —
 * 실제 수집이 그렇고, 그게 커서 경계의 가장 어려운 경우다.
 * 넣은 순서대로 id 를 돌려준다.
 */
export async function insertTestItems(
  collectionId: string,
  sourceId: string,
  rows: readonly TestItemInput[],
): Promise<string[]> {
  if (rows.length === 0) return []
  const values = rows.map((row, i) => ({
    collection_id: collectionId,
    source_id: sourceId,
    external_key: row.externalKey ?? `k-${i}-${randomUUID().slice(0, 6)}`,
    data_json: JSON.stringify(row.data),
    raw_json: JSON.stringify({ _row: row.data }),
    provenance_json: JSON.stringify({}),
    content_hash: `h-${i}`,
    first_seen_at: row.firstSeenAt?.toISOString() ?? null,
  }))
  const inserted = await queryClient<{ id: string; external_key: string }[]>`
    insert into items (collection_id, source_id, external_key, data_json, raw_json, provenance_json,
                       content_hash, first_seen_at, last_seen_at)
    select x.collection_id::uuid, x.source_id::uuid, x.external_key, x.data_json::jsonb, x.raw_json::jsonb,
           x.provenance_json::jsonb, x.content_hash,
           coalesce(x.first_seen_at::timestamptz, now()), coalesce(x.first_seen_at::timestamptz, now())
    from json_to_recordset(${JSON.stringify(values)}::json) as x(
      collection_id text, source_id text, external_key text, data_json text, raw_json text,
      provenance_json text, content_hash text, first_seen_at text
    )
    returning id, external_key
  `
  const byKey = new Map(inserted.map((r) => [r.external_key, r.id]))
  return values.map((v) => byKey.get(v.external_key) ?? '')
}

export async function addTestMember(collectionId: string, userId: string): Promise<void> {
  await queryClient`
    insert into collection_members (collection_id, user_id, role) values (${collectionId}, ${userId}, 'viewer')
  `
}

/** 저장된 뷰를 DB 에 직접 넣는다 — "예전에 저장된 뷰" 호환 시험에 쓴다 (새 칸 없이) */
export async function insertRawView(input: {
  collectionId: string
  ownerId: string
  slug: string
  name: string
  where: unknown
  sort?: unknown
  columns?: unknown
  searchQ?: string | null
  sourceHost?: string | null
}): Promise<string> {
  const rows = await queryClient<{ id: string }[]>`
    insert into views (collection_id, slug, name, where_json, sort_json, columns_json, owner_id, search_q, source_host)
    values (${input.collectionId}, ${input.slug}, ${input.name}, ${JSON.stringify(input.where)}::jsonb,
            ${JSON.stringify(input.sort ?? [])}::jsonb,
            ${input.columns === undefined || input.columns === null ? null : JSON.stringify(input.columns)}::jsonb,
            ${input.ownerId}, ${input.searchQ ?? null}, ${input.sourceHost ?? null})
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) throw new Error('뷰를 만들지 못했다')
  return id
}
