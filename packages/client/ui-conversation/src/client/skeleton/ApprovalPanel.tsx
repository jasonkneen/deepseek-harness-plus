import { useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunningToolCall } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingApproval, type ApprovalComposerProps } from '../contract/slots.ts'
import { rootToolCall } from '../chat/tool-node-reader.ts'
import css from './ApprovalPanel.module.css'

/** Extract the shell command from an approval's paired running call (bash-family args carry `command`); undefined hides the line. */
export function commandOf(call: RunningToolCall | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    return undefined
  }
}

/**
 * Render one pending approval and remount local answer state per request.
 * @param props - the selector-matched pending approval carrier plus the framework standard kit.
 * @returns The approval prompt for this request.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = useMemo(() => new PendingApproval(props.matched), [props.matched])
  const command = props.useSession((snapshot) => {
    if (approval.callId === undefined) return undefined
    const root = rootToolCall(snapshot, approval.callId)
    if (root === undefined) return undefined
    return root.callId === approval.callId && !('kind' in root) ? commandOf(root) : undefined
  })
  return <ApprovalFlow key={approval.key} pending={approval} t={props.t} {...command === undefined ? {} : { command }} />
}

function ApprovalFlow({ pending, command, t }: {
  pending: PendingApproval
  command?: string
  t: ApprovalComposerProps['t']
}) {
  // Keep actions disabled until the resolved frame arrives; failed answers
  // re-enable them for retry.
  const [answered, setAnswered] = useState(false)
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setAnswered(true)
    void pending.answer(outcome).catch(() => { setAnswered(false) })
  }
  return (
    <div className={css.root} data-approval-key={pending.key}>
      <div className={css.card}>
        <div className={css.strip}><span className={css.dot} />{t('approval.waiting')}</div>
        {/* Tab stop: the region scrolls once the command passes the cap and
            holds nothing focusable of its own, so without one a keyboard-only
            user cannot reach the command's tail before answering. */}
        <div className={css.body} data-approval-scroll="" tabIndex={0} role="group" aria-label={t('approval.detail.aria')}>
          <div className={css.headline}>{pending.reason ?? t('approval.escalation', { toolName: pending.toolName })}</div>
          {command !== undefined && <div className={css.command}>{command}</div>}
        </div>
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { answer('rejected') }}>
            {t('approval.reject')}
          </Button>
          <Button variant="primary" disabled={answered} onClick={() => { answer('allowed-once') }}>
            {t('approval.allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}
