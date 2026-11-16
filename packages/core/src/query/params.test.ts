// 파라미터 파싱은 DB 없이 순수하게 검증된다. 기획서 12장 표의 회귀 테스트다.
//
// A46 이후의 규칙: 적용할 수 없는 조건은 **거절**한다 (예전: 버리고 경고 → 더 넓은 결과).
// 그래서 여기 테스트의 절반은 "무엇을 거절하고, 거절 문장이 무엇을 말하는가" 다.

import { describe, expect, it } from 'vitest'

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type CollectionQuery, type QueryProblem } from '../types/api'
import type { FieldDef } from '../types/collection'
import {
  decodeCursor,
  encodeCursor,
  normalizeDateValue,
  normalizeEnumValue,
  normalizeInstantValue,
  normalizeNumberValue,
  parseCollectionQuery,
  toCollectionFilter,
} from './params'

/** G0 계약 (4) 의 시드 스키마와 같은 6개 */
const FIELDS: FieldDef[] = [
  { key: 'title', label: '사업명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'organization', label: '주관기관', type: 'text', required: false, mapping: null, value_labels: null },
  { key: 'deadline', label: '마감일', type: 'date', required: false, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  {
    key: 'category',
    label: '분야',
    type: 'enum',
    required: false,
    mapping: { 'R&D': 'rnd', 기술개발: 'rnd', 창업: 'startup' },
    value_labels: null,
  },
  { key: 'link', label: '원문', type: 'link', required: true, mapping: null, value_labels: null },
]

const parse = (qs: string) => parseCollectionQuery(qs, FIELDS)

/** 통과해야 하는 입력 — 실패면 문제를 보여주며 테스트를 깬다 */
function ok(qs: string): CollectionQuery {
  const result = parse(qs)
  if (!result.ok) throw new Error(`통과해야 하는데 거절됨: ${JSON.stringify(result.problems)}`)
  return result.query
}

/** 거절돼야 하는 입력 — 문제 목록을 돌려준다 */
function rejected(qs: string): QueryProblem[] {
  const result = parse(qs)
  if (result.ok) throw new Error(`거절돼야 하는데 통과함: ${qs}`)
  return result.problems
}

const UUID = '11111111-1111-1111-1111-111111111111'

describe('필드 필터', () => {
  it('스키마 필드 키가 그대로 파라미터가 된다', () => {
    expect(ok('category=rnd&title=청년').eq).toEqual({ category: 'rnd', title: '청년' })
  })

  it('money 필드는 숫자로, 콤마는 무시한다', () => {
    expect(ok('amount=100,000,000').eq).toEqual({ amount: 100_000_000 })
  })

  it('enum 은 원문 표기로 물어봐도 정규화된 값으로 바꿔준다', () => {
    expect(ok('category=R%26D').eq['category']).toBe('rnd')
    expect(ok('category=기술개발').eq['category']).toBe('rnd')
  })

  it('빈 값은 조건 없음으로 본다 — 폼이 비워 둔 칸을 그대로 보내는 관례', () => {
    const query = ok('category=&deadline_gte=&q=')
    expect(query.eq).toEqual({})
    expect(query.gte).toEqual({})
    expect(query.q).toBeUndefined()
  })
})

describe('범위 조건', () => {
  it('date · money 에는 걸린다', () => {
    const query = ok('deadline_gte=2026-08-01&deadline_lte=2026-08-31&amount_gte=50000000')
    expect(query.gte).toEqual({ deadline: '2026-08-01', amount: 50_000_000 })
    expect(query.lte).toEqual({ deadline: '2026-08-31' })
  })

  it('text 필드에는 못 건다 — 조용히 무시하지 않고 거절한다 (A46)', () => {
    const problems = rejected('title_gte=a')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ code: 'invalid_query', param: 'title_gte' })
    expect(problems[0]?.message).toContain('사업명')
  })

  it('enum · link 도 범위 대상이 아니다', () => {
    expect(rejected('category_gte=a')[0]?.param).toBe('category_gte')
    expect(rejected('link_lte=a')[0]?.param).toBe('link_lte')
  })

  it('달력에 없는 날짜는 거절한다 — 무엇을 보내야 하는지 말한다', () => {
    const problems = rejected('deadline_gte=2026-02-31')
    expect(problems[0]?.message).toContain('YYYY-MM-DD')
  })

  it('날짜 뒤에 무엇이 붙어도 거절한다 (앞 10글자만 보고 통과시키지 않는다)', () => {
    expect(rejected('deadline_gte=2026-08-01xyz')[0]?.param).toBe('deadline_gte')
  })

  it('숫자가 아닌 금액은 거절한다', () => {
    expect(rejected('amount_gte=일억')[0]?.param).toBe('amount_gte')
    // Number() 가 너그럽게 읽는 꼴(16진수·지수)도 금액이 아니다
    expect(rejected('amount_gte=0x10')[0]?.param).toBe('amount_gte')
  })
})

describe('모르는 조건 — 더 넓은 결과를 내지 않는다 (A46)', () => {
  it('오타를 조용히 삼키지 않는다', () => {
    const problems = rejected('categroy=rnd')
    expect(problems).toEqual([
      { code: 'invalid_query', message: '이 컬렉션에 없는 조건입니다: categroy', param: 'categroy' },
    ])
  })

  it('없는 필드의 범위 조건도 거절한다', () => {
    expect(rejected('budget_gte=1')[0]?.param).toBe('budget_gte')
  })

  it('문제가 여럿이면 전부 한꺼번에 알려준다', () => {
    const problems = rejected('categroy=rnd&deadline_gte=어제&sort=nope')
    expect(problems.map((p) => p.param)).toEqual(['categroy', 'deadline_gte', 'sort'])
  })

  it('문제 문구에 내부 명사를 쓰지 않는다 (보장선 B2)', () => {
    const problems = rejected('categroy=1&title_gte=a&sort=zzz&limit=abc&since=x&include=raw')
    for (const p of problems) expect(p.message).not.toMatch(/어댑터|스펙|파서|드리프트|run|adapter|spec/i)
  })
})

describe('정렬', () => {
  it('오름차순과 내림차순', () => {
    expect(ok('sort=deadline').sort).toBe('deadline')
    expect(ok('sort=-amount').sort).toBe('-amount')
  })

  it('스키마에 없는 기준은 거절하고 쓸 수 있는 값을 알려준다 — 기본 순서로 몰래 떨어지지 않는다', () => {
    const problems = rejected('sort=nope')
    expect(problems[0]).toMatchObject({ code: 'invalid_query', param: 'sort' })
    expect(problems[0]?.message).toContain('first_seen_at')
  })

  it('first_seen_at · last_seen_at 은 스키마에 없어도 허용된다', () => {
    expect(ok('sort=-first_seen_at').sort).toBe('-first_seen_at')
    expect(ok('sort=last_seen_at').sort).toBe('last_seen_at')
  })
})

describe('페이지', () => {
  it('기본값', () => {
    const query = ok('')
    expect(query.limit).toBe(DEFAULT_PAGE_LIMIT)
    expect(query.cursor).toBeNull()
  })

  it('상한을 넘으면 limit_exceeded 로 거절한다 — 몰래 줄이지 않는다', () => {
    const problems = rejected(`limit=${MAX_PAGE_LIMIT + 1}`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ code: 'limit_exceeded', param: 'limit' })
    expect(problems[0]?.message).toContain(String(MAX_PAGE_LIMIT))
  })

  it('상한 그대로는 통과', () => {
    expect(ok(`limit=${MAX_PAGE_LIMIT}`).limit).toBe(MAX_PAGE_LIMIT)
  })

  it('숫자가 아니거나 1 미만이면 거절', () => {
    expect(rejected('limit=abc')[0]?.code).toBe('invalid_query')
    expect(rejected('limit=0')[0]?.code).toBe('invalid_query')
    expect(rejected('limit=2.5')[0]?.code).toBe('invalid_query')
  })

  it('깨진 커서는 invalid_cursor — 처음부터 다시 주지 않는다 (같은 행을 두 번 받게 된다)', () => {
    const problems = rejected('cursor=%%%')
    expect(problems[0]).toMatchObject({ code: 'invalid_cursor', param: 'cursor' })
  })
})

describe('검색 · 출처 · 신규 · 원문', () => {
  it('q · source · since · include', () => {
    const query = ok('q=청년&source=k-startup.go.kr&since=2026-07-20&include=provenance')
    expect(query).toMatchObject({
      q: '청년',
      source: 'k-startup.go.kr',
      since: '2026-07-20',
      include: ['provenance'],
    })
  })

  it('시각까지 준 since 는 ISO 로 정규화된다', () => {
    expect(ok('since=2026-07-20T09:00:00%2B09:00').since).toBe('2026-07-20T00:00:00.000Z')
  })

  it('못 읽는 since 는 거절한다', () => {
    expect(rejected('since=어제')[0]).toMatchObject({ code: 'invalid_query', param: 'since' })
    // Date 가 너그럽게 읽는 꼴("2026/07/20")도 받지 않는다
    expect(rejected('since=2026%2F07%2F20')[0]?.param).toBe('since')
  })

  it('모르는 include 값은 거절', () => {
    expect(rejected('include=provenance,raw')[0]).toMatchObject({ code: 'invalid_query', param: 'include' })
  })

  it('글자 칸이 없는 컬렉션에 검색어를 주면 거절 — 검색어를 버린 전체 목록을 내지 않는다', () => {
    const numbersOnly: FieldDef[] = [
      { key: 'amount', label: '금액', type: 'money', required: false, mapping: null, value_labels: null },
    ]
    const result = parseCollectionQuery('q=청년', numbersOnly)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]?.param).toBe('q')
  })
})

describe('입력 형태', () => {
  it('URLSearchParams · 문자열 · 객체를 모두 받는다', () => {
    const fromString = ok('category=rnd&limit=10')
    const fromParams = parseCollectionQuery(new URLSearchParams('category=rnd&limit=10'), FIELDS)
    const fromObject = parseCollectionQuery({ category: 'rnd', limit: '10' }, FIELDS)
    expect(fromParams).toEqual({ ok: true, query: fromString })
    expect(fromObject).toEqual({ ok: true, query: fromString })
  })

  it('같은 조건이 여러 번이면 하나를 골라 적용하지 않고 거절한다', () => {
    const problems = rejected('category=rnd&category=startup')
    expect(problems[0]).toMatchObject({ code: 'invalid_query', param: 'category' })
  })

  it('어떤 입력에도 throw 하지 않는다', () => {
    for (const junk of ['%', '&&&', '=x', 'limit=-1&cursor=💥', '__proto__=1', 'constructor=1']) {
      expect(() => parseCollectionQuery(junk, FIELDS)).not.toThrow()
    }
  })
})

describe('커서 왕복 (v2 — 지문·위치를 싣는다)', () => {
  const base = { id: UUID, f: 'fp1', o: 50 }

  it('문자열 정렬값', () => {
    const cursor = encodeCursor({ ...base, s: '2026-08-21' })
    expect(decodeCursor(cursor)).toEqual({ v: 2, ...base, s: '2026-08-21' })
  })

  it('숫자 정렬값', () => {
    expect(decodeCursor(encodeCursor({ ...base, s: 1_000_000 }))?.s).toBe(1_000_000)
  })

  it('정렬값이 비어 있는 행', () => {
    expect(decodeCursor(encodeCursor({ ...base, s: null }))?.s).toBeNull()
  })

  it('한글이 섞여도 깨지지 않는다', () => {
    expect(decodeCursor(encodeCursor({ ...base, s: '청년 창업' }))?.s).toBe('청년 창업')
  })

  it('URL 에 그대로 실을 수 있다 (base64url · 패딩 없음)', () => {
    const cursor = encodeCursor({ ...base, s: '가나다라마바사아자차카타파하'.repeat(3) })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('못 읽는 커서는 전부 null', () => {
    const v1 = btoa(JSON.stringify({ v: 1, s: 'x', id: UUID })).replace(/=+$/, '')
    for (const junk of [
      '',
      '%%%',
      'not-base64!',
      btoa('not json'),
      v1, // 옛 형식은 지문이 없어 받지 않는다 (A46)
      encodeCursor({ ...base, s: 'x', id: 'not-a-uuid' }),
      encodeCursor({ ...base, s: 'x', o: -1 }),
      encodeCursor({ ...base, s: 'x', f: '' }),
    ]) {
      expect(decodeCursor(junk)).toBeNull()
    }
  })

  it('파싱을 통과한 커서는 그대로 살아남는다', () => {
    const cursor = encodeCursor({ ...base, s: '2026-08-21' })
    expect(ok(`cursor=${cursor}`).cursor).toBe(cursor)
  })
})

describe('값 정규화', () => {
  it('날짜', () => {
    expect(normalizeDateValue('2026-08-21')).toBe('2026-08-21')
    expect(normalizeDateValue('2026-02-29')).toBeNull() // 2026 은 윤년이 아니다
    expect(normalizeDateValue('2028-02-29')).toBe('2028-02-29')
    expect(normalizeDateValue('20260821')).toBeNull()
    expect(normalizeDateValue('2026-08-21T00:00')).toBeNull()
  })

  it('시각', () => {
    expect(normalizeInstantValue('2026-07-20')).toBe('2026-07-20')
    expect(normalizeInstantValue('2026-07-20T00:00:00Z')).toBe('2026-07-20T00:00:00.000Z')
    expect(normalizeInstantValue('July 20, 2026')).toBeNull()
  })

  it('숫자', () => {
    expect(normalizeNumberValue('1,000')).toBe(1000)
    expect(normalizeNumberValue('-3.5')).toBe(-3.5)
    expect(normalizeNumberValue('abc')).toBeNull()
    expect(normalizeNumberValue('1e3')).toBeNull()
    expect(normalizeNumberValue('')).toBeNull()
  })

  it('enum 매핑', () => {
    const mapping = { 'R&D': 'rnd', 창업: 'startup' }
    expect(normalizeEnumValue('R&D', mapping)).toBe('rnd')
    expect(normalizeEnumValue('rnd', mapping)).toBe('rnd')
    expect(normalizeEnumValue('기타', mapping)).toBe('기타')
    expect(normalizeEnumValue('R&D', null)).toBe('R&D')
  })
})

describe('구독 조건으로 넘기기', () => {
  it('페이지네이션을 뺀 조건만 남는다 (기획서 10장 filter_json)', () => {
    const filter = toCollectionFilter(ok('category=rnd&limit=10&include=provenance&sort=deadline'))
    expect(filter).not.toHaveProperty('limit')
    expect(filter).not.toHaveProperty('cursor')
    expect(filter).not.toHaveProperty('include')
    expect(filter).toMatchObject({ eq: { category: 'rnd' }, sort: 'deadline' })
  })
})
