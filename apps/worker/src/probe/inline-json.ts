// probe 2단계 — 인라인 JSON 스캔 (기획서 9-1①-2 · ADR A3)
//
//   __NEXT_DATA__ / __NUXT__ / window.__INITIAL_STATE__ / <script type="application/ld+json">(ItemList)
//
// **이 파일은 실제로 동작한다.** 브라우저도 LLM 도 필요 없다 — 정적 HTML 한 장이면 된다.
// 여기서 뚫리면 그 사이트는 비용이 거의 0 인 소스가 된다.
//
// ── 후보는 1급 스펙이 된다 (ADR A43) ───────────────────────────────────
// 전에는 여기서 찾은 후보를 `fetch_mode: 'html'` 로 내보냈다 — core 의 FetchSpec 에
// "HTML 을 받아 script 안의 JSON 을 꺼낸다" 모드가 없었기 때문이고, 그 결과 컴파일 LLM 이
// CSS 선택자로 script 태그 안을 집으려다 추출이 0건이 됐다.
// 이제 `inline_json` 모드가 있으므로 **어느 스크립트인지(`ScriptLocator`)를 같이 들고 나간다.**
// 스펙으로 가리킬 수 없는 그릇(예: ItemList 가 없는 ld+json)만 예전처럼 html 후보로 남는다.

import type { ScriptLocator } from '@endpointer/core/spec'
import { extractAssignedObject, hasItemList, resolveDevaluePayload, tryParse, unwrapFetchedBody } from '@endpointer/core/spec'

import type { ArrayCandidate } from './scan'
import { findRecordArrays, joinJsonPath } from './scan'
import type { StaticPage } from './static'
import type { ProbeCandidate } from './types'

/**
 * 어떤 그릇에서 나왔는지.
 * `locator` 가 null 이면 **스펙으로 가리킬 방법이 없는 그릇**이다 — 후보 순위·필드 발견에는
 * 쓰이지만 inline_json 스펙이 되지는 못한다 (html 후보로 내려간다).
 */
type Holder = { label: string; data: unknown; locator: ScriptLocator | null }

export interface InlineJsonInput {
  page: StaticPage
  minRows: number
}

/**
 * 정적 HTML 에서 인라인 JSON 후보를 뽑는다.
 * 그릇 하나에서 목록 배열이 여러 개 나올 수 있으므로 후보도 여러 개 나온다.
 */
export function scanInlineJson(input: InlineJsonInput): ProbeCandidate[] {
  const { page, minRows } = input
  const holders = collectHolders(page)
  const out: ProbeCandidate[] = []

  for (const holder of holders) {
    // ld+json 의 ItemList 는 구조가 정해져 있으므로 먼저 특별 대우한다
    const itemList = pickItemList(holder.data)
    const arrays: ArrayCandidate[] =
      itemList !== null ? [itemList] : findRecordArrays(holder.data, { minRows, maxCandidates: 6 })

    for (const arr of arrays) {
      out.push({
        id: `${holder.label}${arr.path}`,
        origin: 'inline_json',
        source: {
          kind: 'inline_json',
          script: holder.label,
          json_path: arr.path,
          locator: holder.locator,
        },
        list_path: arr.list_path,
        // 인라인 JSON 은 페이지 안에 들어 있으므로 재수집도 페이지를 받아서 한다 —
        // 받는 것은 HTML 이지만 읽는 것은 JSONPath 다. 그게 inline_json 모드다 (A43).
        // 가리킬 방법이 없는 그릇은 예전처럼 html 후보로 남는다.
        fetch_mode: holder.locator !== null ? 'inline_json' : 'html',
        fetch_url: page.url,
        rows: arr.rows,
        keys: arr.keys,
        where: `${holder.label} 안 ${arr.path} (${arr.size}개)`,
      })
    }
  }

  return out
}

// ── 그릇 모으기 ────────────────────────────────────────────────────────
//
// 스크립트 목록은 `page.page.scripts` 를 쓴다 — 그 목록을 만드는 곳은
// `cheerioAdapter.scripts` 하나이고, 수집 시점의 추출(core `extractInlineJson`)도 같은 것을 본다.
// 그래서 여기서 매긴 순번과 수집 시점의 순번이 어긋날 수 없다 (ADR A43 ④).

function collectHolders(page: StaticPage): Holder[] {
  const holders: Holder[] = []
  /** 이름 없는 application/json 의 순번. **core 의 json_script 필터와 같은 기준으로 센다** */
  let anonJsonIndex = -1

  for (const script of page.page.scripts) {
    const type = (script.type ?? '').toLowerCase()
    const isJsonType = type.includes('application/json') || type === 'json'

    // ① <script id="__NEXT_DATA__" type="application/json">
    if (script.id === '__NEXT_DATA__') {
      const data = tryParse(script.content)
      if (data !== undefined) {
        holders.push({ label: '__NEXT_DATA__', data, locator: { kind: 'id', id: '__NEXT_DATA__', format: 'json' } })
      }
      continue
    }

    // ①-b <script id="__NUXT_DATA__" type="application/json"> — Nuxt 3 의 표준 형태.
    //     내용이 일반 JSON 이 아니라 devalue 배열(값들이 눕고 자리는 인덱스)이라 풀어야 한다
    if (script.id === '__NUXT_DATA__') {
      const data = resolveDevaluePayload(script.content)
      if (data !== undefined) {
        holders.push({
          label: '__NUXT_DATA__',
          data,
          locator: { kind: 'id', id: '__NUXT_DATA__', format: 'devalue' },
        })
      }
      continue
    }

    // ② <script type="application/ld+json"> — 배열일 수도, @graph 안일 수도 있다.
    //    ld_json locator 는 **ItemList 를 내용으로 찾는다**(순번이 아니다 — A43 ①).
    //    그래서 ItemList 가 없는 ld+json 은 가리킬 방법이 없다.
    if (type.includes('ld+json')) {
      const data = tryParse(script.content)
      if (data !== undefined) {
        holders.push({ label: 'ld+json', data, locator: hasItemList(data) ? { kind: 'ld_json' } : null })
      }
      continue
    }

    // ②-b 그 밖의 <script type="application/json"> — SvelteKit 의 data-sveltekit-fetched 가
    //     대표다: {"status":200,"body":"<JSON 문자열>"} 로 **한 번 더 싸여** 있어 벗겨서 쓴다.
    //     프레임워크를 몰라도 JSON 그릇이면 일단 들여다본다 — 목록이 아니면 스캔이 거른다.
    if (isJsonType) {
      if (script.id === null) anonJsonIndex += 1
      const data = tryParse(script.content)
      if (data !== undefined) {
        const label = script.id !== null ? `#${script.id}` : `inline-json[${anonJsonIndex}]`
        holders.push({
          label,
          data: unwrapFetchedBody(data) ?? data,
          // id 가 있으면 id 로 가리키는 것이 순번보다 안정적이다
          locator:
            script.id !== null
              ? { kind: 'id', id: script.id, format: 'json' }
              : { kind: 'json_script', index: anonJsonIndex },
        })
      }
      continue
    }

    // ③ window.__NUXT__ = {...} / window.__INITIAL_STATE__ = {...} / __APOLLO_STATE__
    for (const name of ASSIGNED_GLOBALS) {
      const data = extractAssignedObject(script.content, name)
      if (data !== undefined) holders.push({ label: name, data, locator: { kind: 'global', name } })
    }
  }

  return holders
}

const ASSIGNED_GLOBALS = [
  '__NUXT__',
  '__INITIAL_STATE__',
  '__PRELOADED_STATE__',
  '__APOLLO_STATE__',
  '__remixContext',
] as const

// ── ld+json ItemList ───────────────────────────────────────────────────

/**
 * schema.org ItemList 를 찾아 `itemListElement` 를 목록으로 돌려준다.
 * ListItem 래퍼(`{ @type: 'ListItem', position, item: {…} }`)는 벗겨서 알맹이를 쓴다.
 */
export function pickItemList(data: unknown): ArrayCandidate | null {
  const nodes = flattenLdJson(data)

  for (const { node, path } of nodes) {
    if (typeOf(node).includes('ItemList')) {
      const raw = node['itemListElement']
      if (!Array.isArray(raw) || raw.length < 3) continue

      const rows: Record<string, unknown>[] = []
      let unwrapped = true
      for (const el of raw) {
        if (el === null || typeof el !== 'object' || Array.isArray(el)) {
          unwrapped = false
          break
        }
        const obj = el as Record<string, unknown>
        const inner = obj['item']
        if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
          rows.push(inner as Record<string, unknown>)
        } else {
          rows.push(obj)
          unwrapped = false
        }
      }
      if (rows.length < 3) continue

      const base = joinJsonPath(path, 'itemListElement')
      const listPath = unwrapped ? `${base}[*].item` : `${base}[*]`
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort()

      return { path: base, list_path: listPath, rows, keys, size: rows.length }
    }
  }

  return null
}

function typeOf(node: Record<string, unknown>): string[] {
  const t = node['@type']
  if (typeof t === 'string') return [t]
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string')
  return []
}

/** ld+json 은 객체 하나일 수도, 배열일 수도, `@graph` 안에 들어 있을 수도 있다 */
function flattenLdJson(data: unknown): { node: Record<string, unknown>; path: string }[] {
  const out: { node: Record<string, unknown>; path: string }[] = []

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 4) return
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, joinJsonPath(path, i), depth + 1))
      return
    }
    if (node === null || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    out.push({ node: obj, path })
    const graph = obj['@graph']
    if (graph !== undefined) walk(graph, joinJsonPath(path, '@graph'), depth + 1)
  }

  walk(data, '$', 0)
  return out
}

// ── 이관 메모 ──────────────────────────────────────────────────────────
//
// 벗기는 함수들(`tryParse` · `unwrapFetchedBody` · `extractAssignedObject` · `resolveDevaluePayload`)은
// **core 의 `spec/inline-script.ts` 로 옮겼다** (ADR A43). probe 와 수집이 같은 코드로 벗겨야
// "probe 에서는 보였는데 수집에서는 안 나온다" 가 구조적으로 불가능해진다.
// 이 파일은 그 함수들을 import 해서 쓴다 — 복사해 오지 마라.
