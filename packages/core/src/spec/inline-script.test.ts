// 인라인 JSON 추출 — locator 네 갈래와 **포기하는 것** (ADR A43)
//
// 이 파일이 지키는 회귀 둘:
//   1. `global` 은 JSON.parse 로 안 풀리면 **실패한다**. IIFE 를 읽으려 들면 원칙 ② 가 무너진다.
//   2. `ld_json` 은 순번이 아니라 ItemList 매칭이다 — 앞에 스크립트가 끼어도 같은 것을 찾는다.

import { describe, expect, it } from 'vitest'

import { extractInlineJson, hasItemList, resolveDevaluePayload } from './inline-script'
import type { HtmlAdapter, InlineScript } from './paths'
import type { ScriptLocator } from './spec'

/**
 * 아주 작은 `<script>` 스캐너. **테스트 전용이다** — 제품 코드의 스캐너는 cheerio 쪽
 * `cheerioAdapter.scripts` 하나이고(A43 ④), 여기서는 추출 규칙만 보려고 흉내만 낸다.
 */
const testAdapter: HtmlAdapter = {
  select: () => [],
  scripts(html: string): InlineScript[] {
    const out: InlineScript[] = []
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1] ?? ''
      const content = m[2] ?? ''
      if (content.trim() === '') continue
      out.push({
        id: /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null,
        type: /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null,
        content,
      })
    }
    return out
  },
}

function extract(html: string, locator: ScriptLocator) {
  return extractInlineJson(html, locator, testAdapter)
}

const ROWS = [
  { title: '공고 A', link: '/a' },
  { title: '공고 B', link: '/b' },
  { title: '공고 C', link: '/c' },
]

describe('extractInlineJson — id (__NEXT_DATA__ 류)', () => {
  const html = `<html><body>
    <script>var x = 1;</script>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { list: ROWS } })}</script>
  </body></html>`

  it('id 로 찾아 순수 JSON 을 그대로 읽는다', () => {
    const got = extract(html, { kind: 'id', id: '__NEXT_DATA__', format: 'json' })
    expect(got).toEqual({ ok: true, data: { props: { list: ROWS } } })
  })

  it('없는 id 는 사람이 읽는 사유로 실패한다 (던지지 않는다)', () => {
    const got = extract(html, { kind: 'id', id: '__NOPE__', format: 'json' })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('__NOPE__')
  })

  it('내용이 JSON 이 아니면 실패한다 — 파서는 JSON.parse 하나다', () => {
    const broken = '<script id="__NEXT_DATA__" type="application/json">{ list: [1,2,3] }</script>'
    expect(extract(broken, { kind: 'id', id: '__NEXT_DATA__', format: 'json' }).ok).toBe(false)
  })
})

describe('extractInlineJson — id + devalue (Nuxt 3 __NUXT_DATA__)', () => {
  // devalue: 값들이 한 배열에 눕고, 객체·배열의 원소 자리는 그 배열의 인덱스다
  const DEVALUE = JSON.stringify([{ list: 1 }, [2, 4, 6], { title: 3 }, '공고 A', { title: 5 }, '공고 B', { title: 7 }, '공고 C'])

  it('눕힌 배열을 되돌린다', () => {
    const html = `<script id="__NUXT_DATA__" type="application/json">${DEVALUE}</script>`
    const got = extract(html, { kind: 'id', id: '__NUXT_DATA__', format: 'devalue' })
    expect(got).toEqual({
      ok: true,
      data: { list: [{ title: '공고 A' }, { title: '공고 B' }, { title: '공고 C' }] },
    })
  })

  it('format 을 json 으로 주면 devalue 를 풀지 않는다 (형식은 스펙이 정한다)', () => {
    const html = `<script id="__NUXT_DATA__" type="application/json">${DEVALUE}</script>`
    const got = extract(html, { kind: 'id', id: '__NUXT_DATA__', format: 'json' })
    expect(got.ok).toBe(true)
    if (got.ok) expect(Array.isArray(got.data)).toBe(true)
  })

  it('devalue 가 아닌 내용이면 실패한다', () => {
    const html = '<script id="__NUXT_DATA__" type="application/json">{"a":1}</script>'
    expect(extract(html, { kind: 'id', id: '__NUXT_DATA__', format: 'devalue' }).ok).toBe(false)
  })

  it('순환 참조가 있어도 돌아오지 않는다', () => {
    // 0 → 1 → 0 ... 자기를 가리키는 구조
    expect(resolveDevaluePayload(JSON.stringify([{ a: 1 }, { b: 0 }]))).toEqual({ a: { b: undefined } })
  })
})

describe('extractInlineJson — global (window.X = {…};)', () => {
  it('대입된 객체 리터럴을 꺼낸다', () => {
    const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ list: ROWS })};</script>`
    const got = extract(html, { kind: 'global', name: '__INITIAL_STATE__' })
    expect(got).toEqual({ ok: true, data: { list: ROWS } })
  })

  it('뒤에 다른 코드가 붙어 있어도 괄호 짝까지만 가져온다', () => {
    const html = `<script>
      window.__INITIAL_STATE__ = {"list":[{"title":"A"}]};
      console.log('hi');
      doSomething({ nested: true });
    </script>`
    const got = extract(html, { kind: 'global', name: '__INITIAL_STATE__' })
    expect(got).toEqual({ ok: true, data: { list: [{ title: 'A' }] } })
  })

  it('문자열 안의 괄호에 속지 않는다', () => {
    const html = `<script>window.__S__ = {"t":"}}}","n":1};</script>`
    const got = extract(html, { kind: 'global', name: '__S__' })
    expect(got).toEqual({ ok: true, data: { t: '}}}', n: 1 } })
  })

  // ── 포기하는 것 — 이 셋이 통과하기 시작하면 원칙 ② 가 깨진 것이다 ──
  it('IIFE 는 읽지 않는다 (코드 평가 금지 — 원칙 ② · ADR A43 ②)', () => {
    const html = "<script>window.__NUXT__=(function(a,b){return {list:[a,b]}}('A','B'));</script>"
    expect(extract(html, { kind: 'global', name: '__NUXT__' }).ok).toBe(false)
  })

  it('따옴표 없는 키(JS 객체 리터럴)는 읽지 않는다', () => {
    const html = '<script>window.__S__ = { list: [1,2,3] };</script>'
    expect(extract(html, { kind: 'global', name: '__S__' }).ok).toBe(false)
  })

  it('문자열 연결은 읽지 않는다', () => {
    const html = `<script>window.__S__ = '{"list":' + payload + '}';</script>`
    expect(extract(html, { kind: 'global', name: '__S__' }).ok).toBe(false)
  })
})

describe('extractInlineJson — ld_json (순번이 아니라 ItemList 매칭)', () => {
  const ITEM_LIST = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: ROWS.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: r })),
  }

  it('ItemList 가 든 ld+json 을 찾는다', () => {
    const html = `<script type="application/ld+json">${JSON.stringify(ITEM_LIST)}</script>`
    expect(extract(html, { kind: 'ld_json' })).toEqual({ ok: true, data: ITEM_LIST })
  })

  it('앞에 다른 ld+json 이 끼어도 밀리지 않는다 — 순번 기반이면 여기서 깨진다', () => {
    const breadcrumb = { '@type': 'BreadcrumbList', itemListElement: [] }
    const org = { '@type': 'Organization', name: '어느 기관' }
    const html = `
      <script type="application/ld+json">${JSON.stringify(org)}</script>
      <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
      <script type="application/ld+json">${JSON.stringify(ITEM_LIST)}</script>`
    expect(extract(html, { kind: 'ld_json' })).toEqual({ ok: true, data: ITEM_LIST })
  })

  it('@graph 안에 있어도 찾는다', () => {
    const graph = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, ITEM_LIST] }
    const html = `<script type="application/ld+json">${JSON.stringify(graph)}</script>`
    expect(extract(html, { kind: 'ld_json' })).toEqual({ ok: true, data: graph })
  })

  it('ItemList 가 없으면 실패한다 (가리킬 방법이 없는 그릇)', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization' })}</script>`
    expect(extract(html, { kind: 'ld_json' }).ok).toBe(false)
  })

  it('hasItemList — 배열 @type 도 본다', () => {
    expect(hasItemList({ '@type': ['Thing', 'ItemList'] })).toBe(true)
    expect(hasItemList({ '@type': 'Organization' })).toBe(false)
  })
})

describe('extractInlineJson — json_script (이름 없는 application/json 의 순번)', () => {
  const html = `
    <script id="named" type="application/json">{"no":"이건 이름이 있다"}</script>
    <script type="application/json">${JSON.stringify({ first: true })}</script>
    <script type="application/json">${JSON.stringify({ list: ROWS })}</script>`

  it('이름 없는 것만 세어 n 번째를 집는다', () => {
    expect(extract(html, { kind: 'json_script', index: 0 })).toEqual({ ok: true, data: { first: true } })
    expect(extract(html, { kind: 'json_script', index: 1 })).toEqual({ ok: true, data: { list: ROWS } })
  })

  it('범위를 넘으면 사람이 읽는 사유로 실패한다', () => {
    expect(extract(html, { kind: 'json_script', index: 9 }).ok).toBe(false)
  })

  it('SvelteKit 의 한 겹 포장({status, body})을 벗긴다', () => {
    const wrapped = { status: 200, statusText: 'OK', body: JSON.stringify({ list: ROWS }) }
    const page = `<script type="application/json" data-sveltekit-fetched>${JSON.stringify(wrapped)}</script>`
    expect(extract(page, { kind: 'json_script', index: 0 })).toEqual({ ok: true, data: { list: ROWS } })
  })
})

describe('extractInlineJson — script 가 아예 없을 때', () => {
  it('빈 페이지는 던지지 않고 사유를 준다 (B4)', () => {
    const got = extract('<html><body><p>목록 없음</p></body></html>', { kind: 'ld_json' })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason.length).toBeGreaterThan(0)
  })
})
