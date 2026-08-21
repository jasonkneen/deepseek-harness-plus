import type { Context } from '@deepseek-ai/cordis'
import { IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { searchCardModel } from '../models/search-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type SearchRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const SEARCH_TITLES: Record<string, string> = {
  grep: 'Grep',
  glob: 'Glob',
}

/** Lets users expand grep or glob results and recover capped searches. */
export function SearchRow({ toolName, block, inspect, t }: SearchRowProps) {
  const model = toolRowModel(toolName, block)
  const search = searchCardModel(block)
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconSearchOutline16 size={14} />}
      title={SEARCH_TITLES[toolName] ?? model.title}
      summary={search?.title ?? model.summary}
      body={null}
      // ToolRow ignores output when a structured card is present; otherwise it
      // preserves the generic fallback for errors and legacy results.
      output={model.output}
      errorSummary={model.errorSummary}
      search={search}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** Registers the grep and glob conversation rows. */
export const searchToolview = {
  name: 'search-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'grep', locale: NS }, SearchRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'glob', locale: NS }, SearchRow)
    })
  },
}
