/**
 * The pack's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list, and the patch must activate
 * exactly the providers and backends this bundle promises — the complement of
 * base.spec.ts, which pins base as NOT carrying the backend rows.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'

type PatchRow = { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown> }
type PatchEntry = { patch?: PatchRow[]; insert?: PatchRow[] }

function loadPatch(): { parsed: PatchEntry[]; rows: PatchRow[] } {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const patchPath = resolve(root, manifest.dsh!.bundle!.patch!)
  expect(existsSync(patchPath)).toBe(true)
  const parsed = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
  expect(Array.isArray(parsed)).toBe(true)
  const entries = parsed as PatchEntry[]
  const rows = entries.flatMap(entry => [...(entry.patch ?? []), ...(entry.insert ?? [])])
  return { parsed: entries, rows }
}

describe('dsh-multi-provider bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const { parsed } = loadPatch()
    expect(parsed.length).toBeGreaterThan(0)
    // A later layer must be able to override the provider routes.
    expect(parsed.some(entry => entry.patch?.some(row => row.id === 'llm-pi-ai'))).toBe(true)
  })

  it('activates the Gemini, MiniMax, and Kimi routes on the pi-ai adapter', () => {
    const { rows } = loadPatch()
    // A patch row is id-targeted: it replaces the base bundle's `llm-pi-ai`
    // row, whose plugin name lives in base — the patch itself carries none.
    const piAi = rows.find(row => row.id === 'llm-pi-ai')
    expect(piAi?.config).toBeDefined()
    const providers = (piAi?.config?.['providers'] ?? {}) as Record<string, { apiKeyEnv?: string; models?: { id: string }[] }>
    expect(Object.keys(providers).sort()).toEqual(['anthropic', 'google', 'kimi-coding', 'minimax'])
    expect(providers['google']?.apiKeyEnv).toBe('GOOGLE_API_KEY')
    expect(providers['minimax']?.apiKeyEnv).toBe('MINIMAX_API_KEY')
    expect(providers['kimi-coding']?.apiKeyEnv).toBe('KIMI_CODING_API_KEY')
    expect(providers['anthropic']?.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
    for (const route of ['google', 'minimax', 'kimi-coding', 'anthropic']) {
      const models = providers[route]?.models ?? []
      expect(models.length).toBeGreaterThan(0)
      for (const model of models) expect(model.id.length).toBeGreaterThan(0)
    }
    // Curated flagships must not reference typo'd catalog ids the runtime
    // would reject as UNKNOWN_MODEL; the leaf composition's keyless boot spec
    // revalidates the same ids through ctx.llm.listModels().
    const ids = Object.values(providers).flatMap(p => (p.models ?? []).map(m => m.id))
    expect(ids).toContain('gemini-2.5-flash')
    expect(ids).toContain('MiniMax-M3')
    expect(ids).toContain('kimi-for-coding')
    expect(ids).toContain('claude-opus-5')
  })

  it('composes the delegation backends as disabled tool rows, declared in dependencies', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const { rows } = loadPatch()
    const providers = rows.filter(row => ['subagent-codex', 'subagent-claude-code'].includes(row.id ?? ''))
    expect(providers.map(row => row.name).sort()).toEqual([
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
    ])
    // The engine LLM adapter surfaces both backends as selectable providers
    // on the LLM seam (the web Models picker lists them).
    const engine = rows.find(row => row.id === 'llm-engine')
    expect(engine?.name).toBe('@deepseek-ai/dsh-llm-engine')
    const tools = rows.filter(row => (row.id ?? '').startsWith('tool-subagent-'))
    expect(tools).toHaveLength(2)
    for (const tool of tools) {
      expect(tool.disabled).toBe(true)
      expect(tool.name).toBe('@deepseek-ai/dsh-tool-subagent')
    }
    // Raw patch rows must resolve at load: every plugin named in the patch is
    // a declared dependency (verify-cordis-config enforces the same contract).
    for (const name of ['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-engine', '@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-tool-subagent']) {
      expect(manifest.dependencies).toHaveProperty(name)
    }
  })

  it('evaluates the patch list without JS surprises (evaluate round-trip)', () => {
    // cordis-plugin-loader evaluate() is what the profile composer runs; a
    // patch that fails here cannot boot. No model call happens.
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: string } } }
    const patchPath = resolve(root, manifest.dsh!.bundle!.patch!)
    const parsed = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
    const evaluated: unknown = interpolate({}, parsed)
    expect(evaluated).toBeDefined()
    expect(Array.isArray(evaluated)).toBe(true)
  })
})
