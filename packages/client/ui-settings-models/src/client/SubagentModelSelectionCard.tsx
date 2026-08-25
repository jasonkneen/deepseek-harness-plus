/** User control for model-selectable subagent delegation in new sessions. */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsStore } from './store.ts'
import type { en } from './locales.ts'
import { messageOf } from './store.ts'
import styles from './ModelsSection.module.css'

/** Props for the Host-owned subagent model-selection preference. */
export interface SubagentModelSelectionCardProps {
  /** Current redacted namespace view. */
  namespace: SettingsNamespaceView
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Settings wire face. */
  api: Pick<IApiClient, 'settings'>
  /** Models page controller to refresh after a commit. */
  controller: ModelsSettingsStore
  /** Localized Models copy. */
  t: (key: keyof typeof en) => string
}

/** Read the schema-validated resolved boolean from a namespace view. */
function enabledOf(namespace: SettingsNamespaceView): boolean {
  if (typeof namespace.value !== 'object' || namespace.value === null) return false
  return (namespace.value as { enabled?: unknown }).enabled === true
}

/** Render and persist the default-off new-session preference. */
export function SubagentModelSelectionCard({
  namespace,
  writable,
  api,
  controller,
  t,
}: SubagentModelSelectionCardProps): ReactNode {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const enabled = enabledOf(namespace)

  const toggle = (): void => {
    setSaving(true)
    setSaved(false)
    setError(undefined)
    void api.settings.update({
      ns: namespace.ns,
      patch: { enabled: !enabled },
      expectedRevision: namespace.revision,
    }).then(async (response) => {
      if (!response.result.ok) throw new Error(response.result.error.message)
      controller.acceptNamespace(response.result.value)
      await controller.load()
      setSaved(true)
    }).catch((reason: unknown) => {
      setError(messageOf(reason))
    }).finally(() => { setSaving(false) })
  }

  return (
    <section className={styles['preferenceCard']} aria-labelledby="subagent-model-selection-title">
      <div className={styles['preferenceCopy']}>
        <h3 id="subagent-model-selection-title" className={styles['preferenceTitle']}>
          {t('subagentModelSelectionTitle')}
        </h3>
        <p className={styles['preferenceDescription']}>{t('subagentModelSelectionDescription')}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t('subagentModelSelectionToggle')}
        className={`${styles['switch']} ${enabled ? styles['switchOn'] : ''}`}
        disabled={!writable || saving}
        onClick={toggle}
      >
        <span className={styles['switchThumb']} />
      </button>
      {saved
        ? <p className={styles['preferenceStatus']} role="status">{t('subagentModelSelectionSaved')}</p>
        : null}
      {error === undefined ? null : <p className={styles['error']} role="alert">{error}</p>}
    </section>
  )
}
