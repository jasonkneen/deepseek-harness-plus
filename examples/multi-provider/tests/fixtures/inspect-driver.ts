#!/usr/bin/env node
/**
 * Inspect the multi-provider leaf composition without invoking a model or a
 * product process: print the registered provider routes with their model
 * catalogs, the registered subagent providers, and the model-facing tool
 * schemas. Keyless: route and model metadata come from the pi-ai catalog,
 * never from a provider endpoint.
 *
 * Usage: `node --import tsx inspect-driver.ts <configPath>`
 * @module multi-provider-inspect-driver
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('multi-provider inspect driver requires a config path')
}

const ctx = await boot('multi-provider-inspect', resolveConfigPath(configPath, undefined))
try {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is not composed')
  const providers = []
  for (const info of llm.listProviders()) {
    const models = await llm.listModels(info.id)
    providers.push({
      provider: info.id,
      name: info.name ?? null,
      models: models.map(model => model.id).sort(),
    })
  }
  process.stdout.write(`${JSON.stringify({
    providers,
    subagents: ctx.subagents.list(),
    tools: ctx.tools.schemas().map(schema => schema.name).sort(),
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
