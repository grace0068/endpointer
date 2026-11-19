// 컬렉션 만들기 · 사이트 붙이기의 저장 — 실제 Postgres 위에서 (ADR A50)
//
// 실행한 것: persistNewCollection · persistAttachedSource 의 실제 SQL (테스트 DB endpointer_test).
// 대체한 것: 추출 결과(items·report)는 시험이 직접 만든다 — 사이트·LLM 을 부르지 않는다.

import { createTestUser, prepareTestDb, uniqueTag } from '@endpointer/core/testing'

import { describe, expect, it } from 'vitest'

import type { CollectionSchemaJson } from '@endpointer/core'
import type { AdapterSpec, InterpretedItem } from '@endpointer/core/spec'

const status = await prepareTestDb()

const { queryClient } = await import('@endpointer/core/db')
const { persistAttachedSource, persistNewCollection } = await import('./persist')

const SCHEMA: CollectionSchemaJson = [
  { key: 'title', label: '공모전명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'link', label: '원문링크', type: 'link', required: false, mapping: null, value_labels: null },
]

function spec(url: string): AdapterSpec {
  return {
    spec_version: 1,
    fetch: { mode: 'json', url, method: 'GET', headers: {} },
    list: '$.items[*]',
    fields: { title: { path: '$.title', type: 'text' }, link: { path: '$.url', type: 'link' } },
    pagination: { kind: 'none' },
  } as AdapterSpec
}

function items(tag: string, n: number): InterpretedItem[] {
  return Array.from({ length: n }, (_, i) => ({
    external_key: `${tag}-${i}`,
    external_key_origin: 'dedupe_key',
    data: { title: `공모전 ${tag} ${i}`, link: `https://x.example/${tag}/${i}` },
    raw: { _row: {}, _fields: {} },
  })) as unknown as InterpretedItem[]
}

const report = { checked_at: '2026-11-20T00:00:00.000Z', items_found: 3, fields: {}, passed: true, notes: [] }

async function sourceTimes(sourceId: string) {
  const rows = await queryClient<{ last_run_at: unknown; last_ok_at: unknown }[]>`
    select last_run_at, last_ok_at from sources where id = ${sourceId}`
  return rows[0]
}

describe.skipIf(!status.ok)('첫 수집도 수집이다 — 만들기·붙이기 직후 사이트의 확인 시각이 남는다', () => {
  it('컬렉션을 만들면 첫 사이트에 last_run_at · last_ok_at 이 찍힌다', async () => {
    const tag = uniqueTag('p')
    const owner = await createTestUser('저장 시험')
    const made = await persistNewCollection({
      owner_id: owner,
      name: '공모전 모아보기',
      slug: tag,
      schema: SCHEMA,
      host: 'a.example',
      entry_url: 'https://a.example/list',
      fetch_mode: 'json',
      spec: spec('https://a.example/list'),
      items: items(tag, 3),
      report,
    })
    expect(made.items_inserted).toBe(3)
    const t = await sourceTimes(made.source.id)
    expect(t?.last_run_at).not.toBeNull()
    expect(t?.last_ok_at).not.toBeNull()

    // 두 번째 사이트도 같다
    const attached = await persistAttachedSource({
      collection_id: made.collection.id,
      host: 'b.example',
      entry_url: 'https://b.example/list',
      fetch_mode: 'json',
      spec: spec('https://b.example/list'),
      items: items(`${tag}b`, 2),
      report: { ...report, items_found: 2 },
    })
    expect(attached.items_inserted).toBe(2)
    const t2 = await sourceTimes(attached.source.id)
    expect(t2?.last_run_at).not.toBeNull()
    expect(t2?.last_ok_at).not.toBeNull()
  })
})
