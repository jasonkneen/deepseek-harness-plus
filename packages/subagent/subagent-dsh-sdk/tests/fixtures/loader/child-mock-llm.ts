import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * Scripted model for the CHILD runtime: rejects any route drift, then reports
 * its effective route and process cwd so the driving evidence observes both
 * SDK initialization inputs and the inherited workspace.
 */
class RouteEchoAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('max'), name: 'Maximum' }],
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== 'mock'
      || options.model !== 'mock-routed'
      || options.reasoningEffort !== 'max'
      || options.maxTokens !== 777) {
      throw new Error(`unexpected child route: ${JSON.stringify({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        maxTokens: options.maxTokens,
      })}`)
    }
    const reply = `child route: mock/mock-routed/max/777; cwd: ${process.cwd()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'child-mock-llm'
export const inject = ['llm']

/**
 * Register the cwd-echo adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new RouteEchoAdapter())
}
