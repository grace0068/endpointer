'use client'

// 함께 보기 관리 (ADR A40) — 연결 탭의 주인 전용 구역.
// 새 링크는 만든 응답에서 한 번만 보인다 (원문을 저장하지 않으므로 다시 못 보여준다).

import { useActionState } from 'react'

import type { ShareState } from '@/app/collections/[slug]/share-actions'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { useActionToast } from '@/components/ui/toast'

const SHARE_IDLE: ShareState = { status: 'idle', message: null, inviteUrl: null }

export interface ShareMemberItem {
  id: string
  label: string
  joinedLabel: string
}

type ShareAction = (prev: ShareState, formData: FormData) => Promise<ShareState>

export function ShareManage({
  inviteActive,
  inviteCreatedLabel,
  members,
  create,
  disable,
  removeMember,
}: {
  inviteActive: boolean
  inviteCreatedLabel: string | null
  members: ShareMemberItem[]
  create: ShareAction
  disable: ShareAction
  removeMember: ShareAction
}) {
  const [createState, createAction, createPending] = useActionState(create, SHARE_IDLE)
  const [disableState, disableAction, disablePending] = useActionState(disable, SHARE_IDLE)
  const [removeState, removeAction, removePending] = useActionState(removeMember, SHARE_IDLE)
  // 결과 문구는 전부 오른쪽 위 팝업으로
  useActionToast(createState)
  useActionToast(disableState)
  useActionToast(removeState)

  // 방금 만든 링크가 있으면 그것이 최신 상태다 — "링크가 살아 있어요" 문구보다 앞선다
  const freshUrl = createState.inviteUrl

  return (
    <section className="rounded-card border border-border bg-surface p-7">
      <h2 className="mb-1 text-base font-bold text-ink">함께 보기</h2>
      <p className="mb-2 text-[13px] leading-relaxed text-faint">
        초대 링크를 받은 사람은 구글로 로그인한 뒤 이 작업 화면(표·연결)을 <b>읽기만</b> 할 수 있어요.
        표에서 임시로 걸러 볼 수는 있지만 조건을 저장하거나 설정을 바꿀 수는 없어요.
      </p>
      {/* 서로 다른 접근 경로라는 것을 미리 말한다 (ADR A49) — 하나를 끈다고 다른 것이 막히지 않는다 */}
      <ul className="mb-4 flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-muted">
        <li>링크를 끄거나 다시 만들어도 <b>이미 함께 보는 사람은 그대로</b>예요. 빼려면 아래에서 내보내 주세요.</li>
        <li>
          내보내면 이 화면에는 못 들어와요. 하지만 그 사람이 이미 아는 <b>API 키나 ‘주소를 아는 사람’ 주소</b>로는 계속
          읽을 수 있어요 — 막으려면 연결 화면에서 키를 새로 만들거나 공개범위를 바꿔 주세요.
        </li>
      </ul>

      {freshUrl !== null ? (
        <div className="mb-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-[9px] border border-border bg-canvas px-3.5 py-2.5 font-mono text-[12.5px] text-muted">
            {freshUrl}
          </code>
          <CopyButton value={freshUrl} label="복사" />
        </div>
      ) : (
        inviteActive && (
          <p className="mb-3 text-[13px] text-muted">
            초대 링크가 살아 있어요{inviteCreatedLabel !== null ? ` (${inviteCreatedLabel} 만듦)` : ''}.
            링크 내용은 만들 때만 보여요 — 잃어버렸다면 다시 만들어 주세요.
          </p>
        )
      )}

      <div className="mb-2 flex items-center gap-2">
        <form action={createAction}>
          <Button type="submit" size="sm" disabled={createPending}>
            {inviteActive || freshUrl !== null ? '링크 다시 만들기' : '초대 링크 만들기'}
          </Button>
        </form>
        {(inviteActive || freshUrl !== null) && (
          <form action={disableAction}>
            <Button type="submit" size="sm" variant="outline" disabled={disablePending}>
              링크 끄기
            </Button>
          </form>
        )}
      </div>

      {members.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <h3 className="mb-2 text-[13px] font-bold text-muted">함께 보는 사람</h3>
          <ul className="flex flex-col gap-2">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 text-[13.5px] text-ink">
                <span className="min-w-0 flex-1 truncate">
                  {member.label}
                  <span className="ml-2 text-xs text-faint">{member.joinedLabel}부터</span>
                </span>
                <form action={removeAction}>
                  <input type="hidden" name="member_id" value={member.id} />
                  <Button type="submit" size="sm" variant="outline" disabled={removePending}>
                    내보내기
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
