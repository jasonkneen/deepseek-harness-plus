/** `reference` namespace dictionaries for the unified `@` source. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'reference'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.files': '文件与文件夹',
  'section.sessions': '对话',
  'candidate.noCwd': '（无工作目录）',
} satisfies Record<string, string>

/** The reference namespace key union. */
export type ReferenceKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The unified `@` reference menu's copy. */
    reference: ReferenceKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'section.files': 'Files & folders',
  'section.sessions': 'Sessions',
  'candidate.noCwd': '(no cwd)',
} satisfies Record<ReferenceKey, string>
