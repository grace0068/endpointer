// 인라인 JSON 그릇 커버리지 — day2 §8 후보 "Nuxt3·SvelteKit·Remix 누락" 판정
//
// 픽스처는 각 프레임워크가 실제로 페이지에 심는 형태를 그대로 줄인 것이다:
//   Nuxt 3     <script id="__NUXT_DATA__" type="application/json">[devalue 배열]</script>
//   SvelteKit  <script type="application/json" data-sveltekit-fetched>{"status":200,"body":"<JSON 문자열>"}</script>
//   Remix      window.__remixContext = {...}  (대입형 — 원래부터 잡혔는지 확인)

import { describe, expect, it } from 'vitest'

import { extractPage } from '../html'
import { scanInlineJson } from './inline-json'
import type { StaticPage } from './static'

function pageFrom(html: string): StaticPage {
  return {
    requestedUrl: 'https://example.test/list',
    url: 'https://example.test/list',
    host: 'example.test',
    status: 200,
    contentType: 'text/html',
    charset: 'utf-8',
    html,
    isJson: false,
    page: extractPage(html),
  }
}

const ROWS_EXPECTED = [
  { title: '공고 A', link: '/board/a', date: '2026-08-01' },
  { title: '공고 B', link: '/board/b', date: '2026-08-05' },
  { title: '공고 C', link: '/board/c', date: '2026-08-09' },
]

describe('scanInlineJson — Nuxt 3 (__NUXT_DATA__ · devalue 배열)', () => {
  // devalue 형식: 값들이 한 배열에 눕고, 객체·배열의 원소 자리는 그 배열의 **인덱스**다.
  // {data:{list:[A,B,C]}} + views 숫자 컬럼을 인덱스로 편 것:
  const DEVALUE = JSON.stringify([
    { data: 1 },
    { list: 2 },
    [3, 8, 13],
    { title: 4, link: 5, date: 6, views: 7 },
    '공고 A',
    '/board/a',
    '2026-08-01',
    10,
    { title: 9, link: 10, date: 11, views: 12 },
    '공고 B',
    '/board/b',
    '2026-08-05',
    22,
    { title: 14, link: 15, date: 16, views: 17 },
    '공고 C',
    '/board/c',
    '2026-08-09',
    5,
  ])

  it('devalue 배열을 풀어 목록 후보를 낸다', () => {
    const html = `<html><body><div>목록</div>
      <script id="__NUXT_DATA__" type="application/json">${DEVALUE}</script>
    </body></html>`
    const candidates = scanInlineJson({ page: pageFrom(html), minRows: 3 })

    expect(candidates.length).toBeGreaterThan(0)
    const rows = (candidates[0]?.rows ?? []) as Record<string, unknown>[]
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r['title'])).toEqual(ROWS_EXPECTED.map((r) => r.title))
    // 인덱스(숫자)가 값으로 풀렸는지 — 10 이 "/board/b" 참조가 아니라 조회수 10 으로 남아야 한다
    expect(rows[0]?.['views']).toBe(10)
    expect(rows[1]?.['link']).toBe('/board/b')
  })
})

describe('scanInlineJson — SvelteKit (data-sveltekit-fetched · body 가 JSON 문자열)', () => {
  it('body 문자열을 한 번 더 파싱해 목록 후보를 낸다', () => {
    const inner = JSON.stringify({ items: ROWS_EXPECTED })
    const wrapper = JSON.stringify({ status: 200, statusText: '', headers: {}, body: inner })
    const html = `<html><body>
      <script type="application/json" data-sveltekit-fetched="1" data-url="/api/list">${wrapper}</script>
    </body></html>`
    const candidates = scanInlineJson({ page: pageFrom(html), minRows: 3 })

    expect(candidates.length).toBeGreaterThan(0)
    const rows = (candidates[0]?.rows ?? []) as Record<string, unknown>[]
    expect(rows.map((r) => r['title'])).toEqual(ROWS_EXPECTED.map((r) => r.title))
  })
})

describe('scanInlineJson — Remix (window.__remixContext 대입형)', () => {
  it('대입된 객체 리터럴에서 목록 후보를 낸다', () => {
    const state = JSON.stringify({ state: { loaderData: { 'routes/list': { posts: ROWS_EXPECTED } } } })
    const html = `<html><body>
      <script>window.__remixContext = ${state};</script>
    </body></html>`
    const candidates = scanInlineJson({ page: pageFrom(html), minRows: 3 })

    expect(candidates.length).toBeGreaterThan(0)
    const rows = (candidates[0]?.rows ?? []) as Record<string, unknown>[]
    expect(rows.map((r) => r['title'])).toEqual(ROWS_EXPECTED.map((r) => r.title))
  })
})

describe('scanInlineJson — 기존 그릇 회귀', () => {
  it('__NEXT_DATA__ 는 그대로 잡힌다', () => {
    const html = `<html><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { list: ROWS_EXPECTED } },
      })}</script>
    </body></html>`
    const candidates = scanInlineJson({ page: pageFrom(html), minRows: 3 })
    expect(candidates.length).toBeGreaterThan(0)
  })
})

// ── 후보가 들고 나가는 locator (ADR A43) ───────────────────────────────
//
// 전에는 인라인 JSON 후보가 `fetch_mode: 'html'` 로 내려가 컴파일이 CSS 로 script 안을
// 집으려 들었다(추출 0건). 이제 후보가 **어느 스크립트인지**를 같이 들고 나간다.

describe('scanInlineJson — fetch_mode 와 locator', () => {
  function firstCandidate(html: string) {
    const got = scanInlineJson({ page: pageFrom(html), minRows: 3 })
    expect(got.length).toBeGreaterThan(0)
    return got[0]!
  }

  it('__NEXT_DATA__ 후보는 inline_json 모드 + id locator 다', () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { list: ROWS_EXPECTED } },
    })}</script></body></html>`
    const c = firstCandidate(html)
    expect(c.fetch_mode).toBe('inline_json')
    expect(c.source).toMatchObject({ kind: 'inline_json', locator: { kind: 'id', id: '__NEXT_DATA__', format: 'json' } })
  })

  it('__NUXT_DATA__ 후보의 locator 는 devalue 형식을 적는다', () => {
    // 위 Nuxt 3 블록과 같은 형태 — 행이 여러 키를 가져야 목록 후보로 인정된다
    const DEVALUE = JSON.stringify([
      { data: 1 },
      { list: 2 },
      [3, 7, 11],
      { title: 4, link: 5, date: 6 },
      '공고 A',
      '/board/a',
      '2026-08-01',
      { title: 8, link: 9, date: 10 },
      '공고 B',
      '/board/b',
      '2026-08-05',
      { title: 12, link: 13, date: 14 },
      '공고 C',
      '/board/c',
      '2026-08-09',
    ])
    const html = `<html><body><script id="__NUXT_DATA__" type="application/json">${DEVALUE}</script></body></html>`
    const c = firstCandidate(html)
    expect(c.fetch_mode).toBe('inline_json')
    expect(c.source).toMatchObject({ locator: { kind: 'id', id: '__NUXT_DATA__', format: 'devalue' } })
  })

  it('window 대입형은 global locator 다', () => {
    const html = `<html><body><script>
      window.__INITIAL_STATE__ = ${JSON.stringify({ list: ROWS_EXPECTED })};
    </script></body></html>`
    const c = firstCandidate(html)
    expect(c.fetch_mode).toBe('inline_json')
    expect(c.source).toMatchObject({ locator: { kind: 'global', name: '__INITIAL_STATE__' } })
  })

  it('이름 없는 application/json 은 순번을 적고, 이름 있는 것은 순번을 쓰지 않는다', () => {
    const html = `<html><body>
      <script type="application/json">{"noise":1}</script>
      <script type="application/json">${JSON.stringify({ list: ROWS_EXPECTED })}</script>
      <script id="named" type="application/json">${JSON.stringify({ list: ROWS_EXPECTED })}</script>
    </body></html>`
    const got = scanInlineJson({ page: pageFrom(html), minRows: 3 })
    const anon = got.find((c) => c.source.kind === 'inline_json' && c.source.locator?.kind === 'json_script')
    const named = got.find(
      (c) => c.source.kind === 'inline_json' && c.source.locator?.kind === 'id' && c.source.locator.id === 'named',
    )
    // 이름 없는 것 중 **두 번째**가 목록이다 — 첫 번째(noise)도 세어야 순번이 맞는다
    expect(anon?.source).toMatchObject({ locator: { kind: 'json_script', index: 1 } })
    expect(named).toBeDefined()
  })

  it('ItemList 가 있는 ld+json 은 ld_json locator 다', () => {
    const html = `<html><body><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: ROWS_EXPECTED.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: r })),
    })}</script></body></html>`
    const c = firstCandidate(html)
    expect(c.fetch_mode).toBe('inline_json')
    expect(c.source).toMatchObject({ locator: { kind: 'ld_json' } })
  })

  it('ItemList 가 없는 ld+json 은 가리킬 방법이 없어 html 후보로 남는다', () => {
    const html = `<html><body><script type="application/ld+json">${JSON.stringify({
      '@type': 'Organization',
      employees: ROWS_EXPECTED,
    })}</script></body></html>`
    const got = scanInlineJson({ page: pageFrom(html), minRows: 3 })
    if (got.length > 0) {
      expect(got[0]?.fetch_mode).toBe('html')
      expect(got[0]?.source).toMatchObject({ locator: null })
    }
  })
})
