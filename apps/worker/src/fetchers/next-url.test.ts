// 페이지 넘김 — 모드마다 경로 문법이 다르다 (ADR A43 ③)
//
// `nextUrl` 이 모드를 **불리언으로** 판단하던 곳이다 (`mode === 'json'` → JSONPath, 아니면 CSS).
// inline_json 은 payload 가 HTML 문자열인데 경로는 JSONPath 라서, 그 판단이 그대로 남아 있으면
// 다음 페이지 링크를 CSS 로 찾다가 조용히 1페이지에서 멈춘다. 이 파일이 그 회귀를 잡는다.

import type { AdapterSpec } from '@endpointer/core/spec'
import { AdapterSpecSchema } from '@endpointer/core/spec'
import { describe, expect, it } from 'vitest'

import { resetHtmlCache } from './cheerio-adapter'
import { nextUrl } from './index'

function spec(raw: unknown): AdapterSpec {
  return AdapterSpecSchema.parse(raw)
}

const BASE = 'https://example.test/list'

describe('nextUrl — inline_json + next_link (경로는 JSONPath)', () => {
  const inlineSpec = spec({
    spec_version: 1,
    fetch: {
      mode: 'inline_json',
      url: BASE,
      script: { kind: 'id', id: '__NEXT_DATA__' },
    },
    list: '$.props.list[*]',
    fields: { title: { path: '$.name', type: 'text' } },
    pagination: { kind: 'next_link', path: '$.props.nextUrl', max_pages: 3 },
  })

  const page = (payload: unknown): string =>
    `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`

  it('script 안의 JSON 에서 다음 페이지 주소를 꺼낸다', () => {
    resetHtmlCache()
    const html = page({ props: { list: [{ name: '가' }], nextUrl: '/list?page=2' } })
    expect(nextUrl(inlineSpec, 0, html, BASE)).toBe('https://example.test/list?page=2')
  })

  it('다음 페이지가 없으면 null (빈 문자열·없는 키 모두)', () => {
    resetHtmlCache()
    expect(nextUrl(inlineSpec, 0, page({ props: { list: [], nextUrl: '' } }), BASE)).toBeNull()
    expect(nextUrl(inlineSpec, 0, page({ props: { list: [] } }), BASE)).toBeNull()
  })

  it('script 를 못 찾으면 null — 1페이지 결과는 살아 있다 (원칙 ④)', () => {
    resetHtmlCache()
    expect(nextUrl(inlineSpec, 0, '<html><body><p>없음</p></body></html>', BASE)).toBeNull()
  })

  it('page_param 은 모드와 무관하게 URL 자리표시자로 넘긴다', () => {
    const paged = spec({
      spec_version: 1,
      fetch: {
        mode: 'inline_json',
        url: 'https://example.test/list?page={page}',
        script: { kind: 'id', id: '__NEXT_DATA__' },
      },
      list: '$.props.list[*]',
      fields: { title: { path: '$.name', type: 'text' } },
      pagination: { kind: 'page_param', param: 'page', start: 1, max_pages: 3 },
    })
    expect(nextUrl(paged, 0, '', BASE)).toBe('https://example.test/list?page=2')
    expect(nextUrl(paged, 1, '', BASE)).toBe('https://example.test/list?page=3')
  })
})

describe('nextUrl — 기존 모드 회귀', () => {
  it('html 모드는 CSS 로 링크를 집는다', () => {
    resetHtmlCache()
    const htmlSpec = spec({
      spec_version: 1,
      fetch: { mode: 'html', url: BASE },
      list: 'css:ul > li',
      fields: { title: { path: 'css:a', type: 'text' } },
      pagination: { kind: 'next_link', path: 'css:a.next@href', max_pages: 3 },
    })
    const body = '<html><body><ul><li><a>가</a></li></ul><a class="next" href="/list?p=2">다음</a></body></html>'
    expect(nextUrl(htmlSpec, 0, body, BASE)).toBe('https://example.test/list?p=2')
  })

  it('json 모드는 payload 를 그대로 JSONPath 로 읽는다', () => {
    const jsonSpec = spec({
      spec_version: 1,
      fetch: { mode: 'json', url: BASE },
      list: '$.items[*]',
      fields: { title: { path: '$.name', type: 'text' } },
      pagination: { kind: 'next_link', path: '$.next', max_pages: 3 },
    })
    expect(nextUrl(jsonSpec, 0, { items: [], next: '/list?page=3' }, BASE)).toBe('https://example.test/list?page=3')
  })

  it('none 은 항상 null', () => {
    const noneSpec = spec({
      spec_version: 1,
      fetch: { mode: 'json', url: BASE },
      list: '$.items[*]',
      fields: { title: { path: '$.name', type: 'text' } },
      pagination: { kind: 'none' },
    })
    expect(nextUrl(noneSpec, 0, { items: [] }, BASE)).toBeNull()
  })
})
