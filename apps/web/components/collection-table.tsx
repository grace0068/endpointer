'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { SOURCE_COLUMN_ID, type ApiItem, type FieldDef } from '@endpointer/core'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// ── 값 그리기 ────────────────────────────────────────────────────────────

const EMPTY_MARK = '—'
const NEW_WINDOW_DAYS = 3

function readKey(item: ApiItem, key: string): unknown {
  return (item as unknown as Record<string, unknown>)[key]
}

const numberFormat = new Intl.NumberFormat('ko-KR')

function formatValue(value: unknown, field: FieldDef): string {
  if (value === null || value === undefined || value === '') return EMPTY_MARK
  switch (field.type) {
    case 'money':
      return typeof value === 'number' ? `${numberFormat.format(value)}원` : String(value)
    case 'number':
      return typeof value === 'number' ? numberFormat.format(value) : String(value)
    case 'enum':
      // 저장된 값은 정규화된 키(`rnd`)다. 화면에는 사람 말로 돌려놓는다 (보장선 B2).
      // API 응답은 키를 그대로 유지한다 — `?category=rnd` 가 성립해야 하므로 (기획서 12장).
      return field.value_labels?.[String(value)] ?? String(value)
    default:
      return String(value)
  }
}

/** 마감까지 남은 날. 날짜 타입에만 붙는다 */
function daysLeft(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const target = Date.parse(`${value}T23:59:59+09:00`)
  if (Number.isNaN(target)) return null
  return Math.ceil((target - Date.now()) / 86_400_000)
}

function isRecentlyAdded(item: ApiItem): boolean {
  const seen = Date.parse(item._first_seen_at)
  if (Number.isNaN(seen)) return false
  return Date.now() - seen < NEW_WINDOW_DAYS * 86_400_000
}

/** 출처 칩 색 — 호스트마다 다른 톤이 돌아가며 붙는다 (디자인 시안의 SRC_STYLE) */
const HOST_TONES = ['accent', 'ok', 'healing'] as const

function hostTone(host: string): (typeof HOST_TONES)[number] {
  let hash = 0
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return HOST_TONES[Math.abs(hash) % HOST_TONES.length] ?? 'accent'
}

/**
 * 원문 대조 (기획서 5장 신뢰 계층 · 10장).
 * provenance 가 가리키는 경로로 raw 에서 원문 조각을 꺼낸다.
 */
function rawFragment(item: ApiItem, key: string): string | null {
  const raw = readKey(item, '_raw')
  if (typeof raw !== 'object' || raw === null) return null
  const rawObj = raw as Record<string, unknown>

  // 파이프라인 형태 — `{_row, _fields}`. `_fields` 가 필드별 변환 전 원값이다 (interpret.ts).
  // 이 형태를 안 읽어서 실수집 항목에서 툴팁이 통째로 사라져 있었다 (day2 §8).
  const fields = rawObj['_fields']
  if (typeof fields === 'object' && fields !== null) {
    const original = (fields as Record<string, unknown>)[key]
    if (original !== null && original !== undefined) {
      return typeof original === 'string' ? original : JSON.stringify(original)
    }
  }

  // 경로 키 형태 — 예전 시드가 만든 항목. 다시 시드하기 전의 DB 도 계속 보여야 한다
  const provenance = readKey(item, '_provenance')
  if (typeof provenance !== 'object' || provenance === null) return null
  const path = (provenance as Record<string, unknown>)[key]
  if (typeof path !== 'string') return null
  const original = rawObj[path]
  if (original === null || original === undefined) return null
  return typeof original === 'string' ? original : JSON.stringify(original)
}

/** 값 한 칸. 마우스를 올리면 그 값이 원문에서 어떻게 적혀 있었는지 보인다 */
function ValueCell({ item, field }: { item: ApiItem; field: FieldDef }) {
  const value = readKey(item, field.key)
  const fragment = rawFragment(item, field.key)

  if (field.type === 'link') {
    const href = typeof value === 'string' ? value : null
    if (href === null) return <span className="text-faint">{EMPTY_MARK}</span>
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent underline underline-offset-2 hover:text-accent-hover"
      >
        원문 보기
      </a>
    )
  }

  const text = formatValue(value, field)
  const left = field.type === 'date' ? daysLeft(value) : null

  return (
    <span className="group/cell relative inline-flex items-center gap-1.5">
      <span
        className={cn(
          fragment !== null && 'decoration-border-strong decoration-dotted underline-offset-4',
          fragment !== null && 'underline',
        )}
      >
        {text}
      </span>

      {left !== null && left >= 0 && (
        <Badge tone={left <= 7 ? 'attention' : 'accent'} className="font-extrabold">
          {left === 0 ? '오늘까지' : `D-${left}`}
        </Badge>
      )}

      {fragment !== null && (
        <span
          role="note"
          className={cn(
            'pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-max max-w-xs',
            'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg',
            'group-hover/cell:block',
          )}
        >
          <span className="block text-faint">원문에는 이렇게 적혀 있어요</span>
          <span className="block font-mono break-all text-ink">{fragment}</span>
        </span>
      )}
    </span>
  )
}

// ── 표 ───────────────────────────────────────────────────────────────────
//
// 이 컴포넌트는 **데이터를 거르지도 정렬하지도 않는다** (ADR A46). 받은 행을 그대로 그린다.
// 정렬은 머리글 링크(서버 조회), 검색·출처는 필터 바(서버 조회)다. 브라우저에 200개를 받아
// 거르던 예전 방식은 201번째부터를 검색·정렬에서 조용히 빠뜨렸다.
//
// 여기서 하는 것은 **표시 설정**뿐이다 — 열 순서(끌어서)와 열 보이기/숨기기. 그것도 주소의
// `cols` 로 옮겨 적어서, 새로고침·뒤로 가기가 되살리고 "뷰 저장" 이 그대로 담는다 (A47).

export interface SortLink {
  href: string
  /** 지금 이 열로 정렬 중이면 그 방향 */
  dir: 'asc' | 'desc' | null
}

export interface CollectionTableProps {
  fields: readonly FieldDef[]
  items: ApiItem[]
  /** 보일 열과 순서 (`_source` 포함) */
  columns: readonly string[]
  /** 기본 열 순서 — "열 초기화" 의 기준 */
  defaultColumns: readonly string[]
  /** 열 id → 정렬 링크. 없는 열은 정렬할 수 없다 */
  sortLinks: Record<string, SortLink>
  /**
   * 열 설정을 바꿀 때 갈 주소(현재 상태, `cols` 만 뺀 것). null 이면 열을 못 바꾼다(모두의 컬렉션 상세).
   * 열은 결과를 바꾸지 않으므로 이어보기(cursor)는 그대로 둔다.
   */
  colsHrefBase: string | null
}

function withCols(base: string, cols: readonly string[] | null): string {
  if (cols === null) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}cols=${encodeURIComponent(cols.join(','))}`
}

export function CollectionTable({ fields, items, columns: serverColumns, defaultColumns, sortLinks, colsHrefBase }: CollectionTableProps) {
  const router = useRouter()
  // 열 바꾸기는 **바로** 보인다 — 주소를 바꾸고 서버가 다시 그릴 때까지 기다리면 체크박스가 눌러도
  // 그대로인 것처럼 보였다(브라우저 시험이 잡았다). 서버가 새 열로 그리면 부모가 key 로 새로 만든다
  const [columns, setColumns] = useState<readonly string[]>(serverColumns)
  const dragId = useRef<string | null>(null)
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const editable = colsHrefBase !== null
  const customized = JSON.stringify(columns) !== JSON.stringify(defaultColumns)

  function go(cols: readonly string[] | null): void {
    if (colsHrefBase === null) return
    setColumns(cols ?? defaultColumns)
    // 열 바꾸기는 기록을 쌓지 않는다 — 뒤로 가기는 조건 단위로 움직이는 편이 자연스럽다
    router.replace(withCols(colsHrefBase, cols), { scroll: false })
  }

  function moveColumn(fromId: string, toId: string): void {
    if (fromId === toId) return
    const next = [...columns]
    const fromIdx = next.indexOf(fromId)
    const toIdx = next.indexOf(toId)
    if (fromIdx < 0 || toIdx < 0) return
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, fromId)
    go(next)
  }

  function toggleColumn(id: string): void {
    if (columns.includes(id)) {
      if (columns.length <= 1) return // 열이 하나도 없으면 표가 아니다
      go(columns.filter((c) => c !== id))
    } else {
      // 기본 순서에서의 자리로 끼워 넣는다
      const order = defaultColumns.filter((c) => c === id || columns.includes(c))
      go(order)
    }
  }

  const labelOf = (id: string) => (id === SOURCE_COLUMN_ID ? '출처' : (byKey.get(id)?.label ?? id))

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      {editable && (
        <div className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-2.5 text-xs text-faint">
          <details className="relative">
            <summary className="cursor-pointer select-none font-semibold text-muted hover:text-accent">
              열 고르기
            </summary>
            <div className="absolute left-0 z-30 mt-1.5 flex min-w-44 flex-col gap-1 rounded-lg border border-border bg-surface p-2.5 shadow-lg">
              {defaultColumns.map((id) => (
                <label key={id} className="flex items-center gap-2 text-[13px] text-ink">
                  <input type="checkbox" checked={columns.includes(id)} onChange={() => toggleColumn(id)} />
                  {labelOf(id)}
                </label>
              ))}
            </div>
          </details>
          <span>머리글을 끌어 열 순서를 바꿀 수 있어요</span>
          {customized && (
            <button
              type="button"
              onClick={() => go(null)}
              className="underline underline-offset-2 hover:text-accent"
            >
              열 초기화
            </button>
          )}
        </div>
      )}

      <div className="scroll-x">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-divider">
              {columns.map((id) => {
                const link = sortLinks[id]
                return (
                  <th
                    key={id}
                    draggable={editable}
                    onDragStart={() => {
                      dragId.current = id
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragId.current !== null) moveColumn(dragId.current, id)
                      dragId.current = null
                    }}
                    aria-sort={link?.dir === 'asc' ? 'ascending' : link?.dir === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'px-4 py-2.5 text-left text-[11px] font-semibold tracking-[0.07em] whitespace-nowrap text-faint uppercase',
                      editable && 'cursor-grab active:cursor-grabbing',
                    )}
                  >
                    {link === undefined ? (
                      labelOf(id)
                    ) : (
                      <Link
                        href={link.href}
                        scroll={false}
                        title="눌러서 정렬 — 전체 항목을 서버에서 다시 정렬해요"
                        className="flex items-center gap-1 uppercase text-faint hover:text-muted hover:no-underline"
                      >
                        {labelOf(id)}
                        <span aria-hidden className="text-faint/70">
                          {link.dir === 'asc' ? '↑' : link.dir === 'desc' ? '↓' : ''}
                        </span>
                      </Link>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {items.map((item, rowIndex) => (
              <tr
                key={`${item._link ?? ''}-${item._first_seen_at}-${rowIndex}`}
                className="border-b border-divider last:border-b-0 hover:bg-raised/40"
              >
                {columns.map((id) => {
                  if (id === SOURCE_COLUMN_ID) {
                    return (
                      <td key={id} className="px-4 py-2.5 align-top text-[13.5px] text-ink">
                        <span className="flex items-center gap-1.5">
                          <Badge tone={hostTone(item._source)} className="font-mono font-semibold">
                            {item._source}
                          </Badge>
                          {isRecentlyAdded(item) && (
                            <Badge tone="accent" className="font-extrabold">
                              NEW
                            </Badge>
                          )}
                        </span>
                      </td>
                    )
                  }
                  const field = byKey.get(id)
                  if (field === undefined) return null
                  return (
                    <td key={id} className="px-4 py-2.5 align-top text-[13.5px] text-ink">
                      <ValueCell item={item} field={field} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
