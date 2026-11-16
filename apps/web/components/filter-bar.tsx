// 표 위 필터 바 (델타 2-10 — 뷰 편집은 폼이 아니라 표 위에서 · ADR A46).
// GET 폼이라 자바스크립트 없이 돈다. 제출하면 **주소가 곧 상태**가 되고, 서버가 전체 컬렉션을 다시 조회한다.
// 파라미터 규약은 lib/table-state.ts 머리말.
//
// 숨은 칸 셋이 상태를 이어 준다: 정렬(sort) · 열(cols) · 고치는 중인 뷰(base) · 바에 칸이 없는 조건(x).
// 특히 x 가 없으면 저장된 뷰의 "제외 목록" 같은 조건이 필터를 한 번 누르는 순간 조용히 사라진다.
// 커서는 싣지 않는다 — 조건이 바뀌면 처음부터다.

import Link from 'next/link'

import type { FieldDef } from '@endpointer/core'

import { Button } from '@/components/ui/button'
import { conditionsToParams, type TableUrlState } from '@/lib/table-state'

const DATE_OPTIONS = [
  { value: '', label: '전체' },
  { value: 'this_week', label: '이번 주' },
  { value: 'this_month', label: '이번 달' },
  { value: '7', label: 'D-7 이내' },
  { value: '30', label: 'D-30 이내' },
] as const

const selectClass =
  'h-9 rounded-lg border border-border bg-surface px-2 text-[13px] text-ink focus:border-accent focus:outline-none'
const inputClass =
  'h-9 w-28 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none'

/** enum 필드가 고를 수 있는 값 목록 — value_labels 우선, 없으면 mapping 의 정규화 키 */
function enumOptions(field: FieldDef): { value: string; label: string }[] {
  if (field.value_labels !== null) {
    return Object.entries(field.value_labels).map(([value, label]) => ({ value, label }))
  }
  if (field.mapping !== null) {
    const keys = [...new Set(Object.values(field.mapping))]
    return keys.map((value) => ({ value, label: value }))
  }
  return []
}

/** 지금 값이 목록에 없으면(예: D-14 로 저장된 뷰) 그 값을 옵션으로 더한다 — 안 그러면 다시 제출할 때 조건이 사라진다 */
function withCurrent(options: readonly { value: string; label: string }[], current: string | undefined, label: (v: string) => string) {
  if (current === undefined || current === '' || options.some((o) => o.value === current)) return options
  return [...options, { value: current, label: label(current) }]
}

export function FilterBar({
  basePath,
  fields,
  state,
  hosts,
  mode = 'full',
}: {
  /** 폼이 제출될 경로 (= 표) */
  basePath: string
  fields: readonly FieldDef[]
  /** 지금 상태 (뷰를 보는 중이면 그 뷰의 상태 + base) */
  state: TableUrlState
  /** 출처 고르기에 쓸 호스트 */
  hosts: readonly string[]
  /** basic = 검색·출처만 (모두의 컬렉션 상세) */
  mode?: 'full' | 'basic'
}) {
  const { named, extra } = conditionsToParams(state.where, fields)
  const dateFields = mode === 'full' ? fields.filter((f) => f.type === 'date') : []
  const enumFields = mode === 'full' ? fields.filter((f) => f.type === 'enum' && enumOptions(f).length > 0) : []
  const amountFields = mode === 'full' ? fields.filter((f) => f.type === 'money' || f.type === 'number') : []
  // 텍스트 칸은 "이 단어 포함" (q_<key> → contains). 링크 칸은 조건이 말이 안 되므로 뺀다
  const textFields = mode === 'full' ? fields.filter((f) => f.type === 'text') : []
  const hasText = fields.some((f) => f.type === 'text')
  const sort = state.sort[0]

  const hasValues =
    Object.keys(named).length > 0 || extra.length > 0 || state.q !== null || state.source !== null

  return (
    <form action={basePath} className="flex flex-wrap items-end gap-3 rounded-card border border-border bg-surface px-4 py-3">
      {hasText && (
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-semibold text-faint">
          전체 검색
          <input
            type="search"
            name="q"
            defaultValue={state.q ?? ''}
            maxLength={200}
            placeholder="모든 항목의 글자 칸에서 찾아요"
            className={`${inputClass} w-full`}
          />
        </label>
      )}

      {hosts.length > 1 && (
        <label className="flex flex-col gap-1 text-xs font-semibold text-faint">
          출처
          <select name="source" defaultValue={state.source ?? ''} className={selectClass}>
            <option value="">모든 출처</option>
            {withCurrent(hosts.map((h) => ({ value: h, label: h })), state.source ?? undefined, (v) => v).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {dateFields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-xs font-semibold text-faint">
          {field.label}
          <select name={`d_${field.key}`} defaultValue={named[`d_${field.key}`] ?? ''} className={selectClass}>
            {withCurrent(DATE_OPTIONS, named[`d_${field.key}`], (v) => `D-${v} 이내`).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      {enumFields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-xs font-semibold text-faint">
          {field.label}
          <select name={`e_${field.key}`} defaultValue={named[`e_${field.key}`] ?? ''} className={selectClass}>
            <option value="">전체</option>
            {withCurrent(enumOptions(field), named[`e_${field.key}`], (v) => v).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      {textFields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-xs font-semibold text-faint">
          {field.label}
          <input
            name={`q_${field.key}`}
            defaultValue={named[`q_${field.key}`] ?? ''}
            placeholder="포함 단어"
            maxLength={200}
            className={inputClass}
          />
        </label>
      ))}

      {amountFields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-xs font-semibold text-faint">
          {field.label}
          <span className="flex items-center gap-1.5">
            <input
              name={`min_${field.key}`}
              defaultValue={named[`min_${field.key}`] ?? ''}
              inputMode="numeric"
              placeholder="이상"
              className={inputClass}
            />
            <span className="text-faint">~</span>
            <input
              name={`max_${field.key}`}
              defaultValue={named[`max_${field.key}`] ?? ''}
              inputMode="numeric"
              placeholder="이하"
              className={inputClass}
            />
          </span>
        </label>
      ))}

      {/* 상태를 이어 주는 숨은 칸 (머리말) */}
      {extra.length > 0 && <input type="hidden" name="x" value={JSON.stringify(extra)} />}
      {sort !== undefined && <input type="hidden" name="sort" value={sort.dir === 'desc' ? `-${sort.field}` : sort.field} />}
      {state.columns !== null && <input type="hidden" name="cols" value={state.columns.join(',')} />}
      {state.base !== null && <input type="hidden" name="base" value={state.base} />}

      <div className="flex items-center gap-2 pb-0.5">
        <Button type="submit" size="sm" variant="outline">
          걸러보기
        </Button>
        {hasValues && (
          <Link href={basePath} className="text-[13px] text-faint hover:text-accent">
            지우기
          </Link>
        )}
      </div>
    </form>
  )
}
