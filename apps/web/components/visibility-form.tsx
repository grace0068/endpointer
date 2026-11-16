'use client'

import { useActionState } from 'react'

import type { ManageState } from '@/components/collection-manage'
import { Button } from '@/components/ui/button'
import { useActionToast } from '@/components/ui/toast'

const IDLE: ManageState = { status: 'idle', message: null }

// 값 순서는 조심스러운 쪽부터 (원본 Settings 의 공개범위 셀렉트). 설명 없이 이름만 — 짧게
const OPTIONS = [
  { value: 'private', label: '비공개' },
  { value: 'unlisted', label: '주소를 아는 사람' },
  { value: 'public', label: '전체공개' },
] as const

/** 공개범위 한 줄 폼 — 고르고 저장. API 인증도 이 값을 따라간다 */
export function VisibilityForm({
  current,
  save,
}: {
  current: string
  save: (prev: ManageState, formData: FormData) => Promise<ManageState>
}) {
  const [state, action, pending] = useActionState(save, IDLE)
  useActionToast(state)

  return (
    <form action={action} className="flex flex-wrap items-center gap-2.5">
      <select
        name="visibility"
        defaultValue={current}
        className="h-9 max-w-[320px] flex-1 rounded-lg border-[1.5px] border-border-strong bg-raised px-3 text-sm text-ink focus:border-accent focus:outline-none"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        저장
      </Button>
      {/* 실제 판정과 같은 말 (ADR A49) — 이 값은 바깥(REST·AI·모두의 컬렉션)에만 걸린다 */}
      <dl className="mt-2 grid w-full gap-1.5 text-[12.5px] leading-relaxed text-muted">
        {EXPLAIN.map((row) => (
          <div key={row.value} className={row.value === current ? 'text-ink' : undefined}>
            <dt className="inline font-semibold">{row.label}</dt>
            <dd className="inline"> — {row.text}</dd>
          </div>
        ))}
        <div className="text-faint">
          어느 쪽이든 이 작업 화면(표·뷰·설정)은 주인과 초대받은 사람만 들어올 수 있어요.
        </div>
      </dl>
    </form>
  )
}

const EXPLAIN = [
  {
    value: 'private',
    label: '비공개',
    text: 'REST API·AI 연결은 API 키가 있어야 열려요. 모두의 컬렉션에 올릴 수 없고 복제도 안 돼요.',
  },
  {
    value: 'unlisted',
    label: '주소를 아는 사람',
    text: '키 없이 주소만 알면 REST API·AI 연결로 항목을 읽을 수 있어요. 목록에 드러나지 않고 복제는 안 돼요.',
  },
  {
    value: 'public',
    label: '전체공개',
    text: '누구나 REST API·AI 연결로 읽고, 모두의 컬렉션 상세 화면에서도 볼 수 있어요. 모두의 컬렉션에 올리면 다른 사람이 복제할 수 있어요.',
  },
] as const
