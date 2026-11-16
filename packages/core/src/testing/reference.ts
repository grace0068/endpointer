// 표면 일치 검증용 고정 데이터 (ADR A46·A50)
//
// 웹 표 · REST · MCP 세 표면의 테스트가 **같은 데이터 · 같은 조건 · 같은 기준 시각**으로 돌고,
// 결과를 **같은 기대값**과 비교한다. 기대값은 아래 정의에서 JS 로 직접 계산한다 — 조회 코드를
// 다시 부르지 않는다. 세 표면이 각자 이 기대값과 같으면 셋은 서로 같다.
// (세 앱은 서로를 import 하지 않으므로 한 파일에서 셋을 부를 수 없다 — 그래서 기대값이 다리다)
//
// 정렬 기준(금액)은 행마다 다르게 둔다 — 동률의 순서는 id 로 정해져 JS 로 미리 알 수 없기 때문이다.
// 동률·null 의 페이지 경계는 core 의 query.db.test.ts 가 따로 본다.

import './test-db'

import type { CollectionSchemaJson, Visibility } from '../types/collection'
import {
  createTestCollection,
  createTestSource,
  createTestUser,
  insertRawView,
  insertTestItems,
  uniqueTag,
  type TestCollection,
} from './fixtures'

export const REFERENCE_FIELDS: CollectionSchemaJson = [
  { key: 'title', label: '공고명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  { key: 'category', label: '분야', type: 'enum', required: false, mapping: { 'R&D': 'rnd', 창업: 'startup' }, value_labels: null },
  { key: 'link', label: '원문', type: 'link', required: false, mapping: null, value_labels: null },
]

/** 기준 시각 — 2026-08-10 (월) 12:00 KST */
export const REFERENCE_NOW = new Date('2026-08-10T03:00:00.000Z')

/** 200개를 넘게 둔다 — 화면이 예전에 200개만 받던 경계 너머를 본다 */
export const REFERENCE_COUNT = 240

export interface ReferenceRow {
  i: number
  host: string
  title: string
  deadline: string
  amount: number
  category: 'rnd' | 'startup'
  link: string
}

export function referenceRows(hostA: string, hostB: string): ReferenceRow[] {
  return Array.from({ length: REFERENCE_COUNT }, (_, i) => ({
    i,
    host: i < 160 ? hostA : hostB,
    title: `공고 ${String(i).padStart(3, '0')}${i % 4 === 0 ? ' 청년' : ''}`,
    deadline: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
    amount: (i + 1) * 1000, // 행마다 다르다 (머리말)
    category: i % 3 === 0 ? 'rnd' : 'startup',
    link: `https://ref.example/${i}`,
  }))
}

export interface ReferenceSeed {
  ownerId: string
  collection: TestCollection
  hostA: string
  hostB: string
  /** 저장된 뷰 — D-7 이내 · R&D · 검색어 '청년' · 금액 큰 순 (상대 날짜라 기준 시각에 기대값이 달린다) */
  viewSlug: string
  rows: ReferenceRow[]
  /** 뷰의 기대 결과 (링크 순서) */
  expectedView: string[]
  /** 임시 조건 `source=hostB & sort=-amount` 의 기대 결과 (80개 — 여러 페이지) */
  expectedAdhoc: string[]
  /** 그 임시 조건의 REST 쿼리 문자열 */
  adhocQuery: string
}

export async function seedReference(opts: { visibility?: Visibility; apiKeyHash?: string | null } = {}): Promise<ReferenceSeed> {
  const tag = uniqueTag('ref')
  const hostA = `a.${tag}.example`
  const hostB = `b.${tag}.example`
  const ownerId = await createTestUser('기준 데이터 주인')
  const collection = await createTestCollection({
    ownerId,
    schema: REFERENCE_FIELDS,
    visibility: opts.visibility ?? 'unlisted',
    apiKeyHash: opts.apiKeyHash ?? null,
  })
  const sA = await createTestSource(collection.id, hostA)
  const sB = await createTestSource(collection.id, hostB)
  const rows = referenceRows(hostA, hostB)
  const toItem = (r: ReferenceRow) => ({
    data: { title: r.title, deadline: r.deadline, amount: r.amount, category: r.category, link: r.link },
    externalKey: `ref-${r.i}`,
  })
  await insertTestItems(collection.id, sA, rows.filter((r) => r.host === hostA).map(toItem))
  await insertTestItems(collection.id, sB, rows.filter((r) => r.host === hostB).map(toItem))

  const viewSlug = 'youth-soon'
  await insertRawView({
    collectionId: collection.id,
    ownerId,
    slug: viewSlug,
    name: '곧 마감 청년 R&D',
    where: [
      { field: 'deadline', op: 'd_within', value: 7 },
      { field: 'category', op: 'in', value: ['rnd'] },
    ],
    sort: [{ field: 'amount', dir: 'desc' }],
    searchQ: '청년',
  })

  // 기대값 — JS 로 직접 (기준 시각 2026-08-10 KST → D-7 이내 = 08-10 ~ 08-17)
  const byAmountDesc = (a: ReferenceRow, b: ReferenceRow) => b.amount - a.amount
  const expectedView = rows
    .filter((r) => r.deadline >= '2026-08-10' && r.deadline <= '2026-08-17' && r.category === 'rnd' && r.title.includes('청년'))
    .sort(byAmountDesc)
    .map((r) => r.link)
  const expectedAdhoc = rows.filter((r) => r.host === hostB).sort(byAmountDesc).map((r) => r.link)

  return {
    ownerId,
    collection,
    hostA,
    hostB,
    viewSlug,
    rows,
    expectedView,
    expectedAdhoc,
    adhocQuery: `source=${hostB}&sort=-amount`,
  }
}
