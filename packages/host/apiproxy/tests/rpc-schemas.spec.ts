import { describe, expect, it } from 'vitest'
import { RpcId, transportError } from '../src/api/rpc.ts'
import {
  clientRequestSchema, rpcErrorSchema, rpcIdSchema, rpcMessageSchema,
  rpcResultSchema, serverResponseSchema,
} from '../src/api/rpc.schema.ts'
import { z } from 'zod'
import {
  hostCreateDirectoryRequestSchema, hostCreateDirectoryValueSchema,
  hostDescribeRequestSchema, hostDescribeValueSchema,
  hostListDirectoryRequestSchema, hostListDirectoryValueSchema,
} from '../src/api/host.schema.ts'
import { skillEntrySchema, skillListRequestSchema, skillListValueSchema } from '../src/api/skills.schema.ts'
import { agentPresetOpenDocumentValueSchema } from '../src/api/agent-presets.schema.ts'

describe('RpcId', () => {
  it('brands a raw string at zero runtime cost', () => {
    expect(RpcId('abc')).toBe('abc')
    expect(rpcIdSchema.parse('abc')).toBe('abc')
    // No min-length: the id is an opaque echo token (see rpcIdSchema's contract).
    expect(rpcIdSchema.parse('')).toBe('')
    expect(() => rpcIdSchema.parse(42)).toThrow()
  })
})

describe('transportError', () => {
  it('folds Error and non-Error throws into the internal error branch', () => {
    expect(transportError(new Error('wire down'))).toEqual({ ok: false, error: { code: 'internal', message: 'wire down', details: {} } })
    expect(transportError('raw')).toMatchObject({ ok: false, error: { code: 'internal', message: 'raw' } })
  })
})

describe('rpcErrorSchema', () => {
  it('accepts every code branch with its required details', () => {
    expect(rpcErrorSchema.parse({ code: 'bad-request', message: 'm', details: { issues: [] } }).code).toBe('bad-request')
    expect(rpcErrorSchema.parse({ code: 'cancelled', message: 'm', details: {} }).code).toBe('cancelled')
    expect(rpcErrorSchema.parse({ code: 'session-not-found', message: 'm', details: { sessionId: 's' } }).code).toBe('session-not-found')
    expect(rpcErrorSchema.parse({ code: 'invalid-time-zone', message: 'm', details: { value: 'CST' } }).code).toBe('invalid-time-zone')
    expect(rpcErrorSchema.parse({ code: 'directory-unreadable', message: 'm', details: { path: '/x' } }).code).toBe('directory-unreadable')
    expect(rpcErrorSchema.parse({ code: 'directory-exists', message: 'm', details: { path: '/x' } }).code).toBe('directory-exists')
    expect(rpcErrorSchema.parse({ code: 'directory-create-failed', message: 'm', details: { path: '/x' } }).code).toBe('directory-create-failed')
    expect(rpcErrorSchema.parse({ code: 'directory-picker-unavailable', message: 'm', details: { capability: 'none' } }).code).toBe('directory-picker-unavailable')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-read-only', message: 'm', details: { agentPreset: 'p', reason: 'system' } }).code).toBe('agent-preset-read-only')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-locked', message: 'm', details: { sessionId: 's', agentPreset: 'p' } }).code).toBe('agent-preset-locked')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-not-found', message: 'm', details: { agentPreset: 'p', available: [] } }).code).toBe('agent-preset-not-found')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-invalid', message: 'm', details: { agentPreset: 'p', reason: 'bad' } }).code).toBe('agent-preset-invalid')
    expect(rpcErrorSchema.parse({ code: 'agent-busy', message: 'm', details: { reason: 'r' } }).code).toBe('agent-busy')
    expect(rpcErrorSchema.parse({ code: 'settings-rejected', message: 'm', details: { ns: 'n' } }).code).toBe('settings-rejected')
    expect(rpcErrorSchema.parse({ code: 'settings-conflict', message: 'm', details: { ns: 'n', expected: 1, actual: 2 } }).code).toBe('settings-conflict')
    // The credentials producer still emits this code, so the branch has to stay.
    expect(rpcErrorSchema.parse({ code: 'credential-rejected', message: 'm', details: { ref: 'r' } }).code).toBe('credential-rejected')
    expect(rpcErrorSchema.parse({ code: 'model-discovery-failed', message: 'm', details: { settingsNs: 'n' } }).code).toBe('model-discovery-failed')
    expect(rpcErrorSchema.parse({ code: 'internal', message: 'm', details: {} }).code).toBe('internal')
  })

  it('rejects a known code with missing details', () => {
    expect(() => rpcErrorSchema.parse({ code: 'agent-busy', message: 'm', details: {} })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'directory-unreadable', message: 'm', details: {} })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'internal', message: 'm' })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'nope', message: 'm', details: {} })).toThrow()
  })
})

describe('rpcResultSchema', () => {
  it('accepts both result branches and rejects hybrids', () => {
    const schema = rpcResultSchema(z.object({ n: z.number() }))
    expect(schema.parse({ ok: true, value: { n: 1 } })).toEqual({ ok: true, value: { n: 1 } })
    const err = schema.parse({ ok: false, error: { code: 'internal', message: 'x', details: {} } })
    expect(err).toMatchObject({ ok: false })
    expect(() => schema.parse({ ok: true, error: {} })).toThrow()
  })
})

describe('wire full-form schemas', () => {
  it('parses both carrier forms and the union discriminates on type', () => {
    const cq = { type: 'client-request', rpcId: 'r1', method: 'host.describe', payload: {} }
    const sr = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 1 } }
    expect(clientRequestSchema.parse(cq).method).toBe('host.describe')
    expect(serverResponseSchema.parse(sr).rpcId).toBe('r1')
    for (const message of [cq, sr]) expect(rpcMessageSchema.parse(message)).toBeTruthy()
    expect(() => rpcMessageSchema.parse({ type: 'other', rpcId: 'x' })).toThrow()
  })

  it('rejects a quadrant missing its members but accepts a valueless success result', () => {
    expect(() => clientRequestSchema.parse({ type: 'client-request', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1', result: {} })).toThrow()
    // A void business result carries no value field; the endpoint's own second
    // parse is what requires a value for methods that return data.
    expect(serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1', result: { ok: true } }).rpcId)
      .toBe('r1')
  })
})

describe('host domain schemas', () => {
  it('validates describe request/value', () => {
    expect(hostDescribeRequestSchema.parse({})).toEqual({})
    const value = hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', provider: 'p', model: 'm', attachedSessions: 2, home: '/h', canOpenPath: true,
    })
    expect(value).toMatchObject({ provider: 'p', model: 'm', attachedSessions: 2, canOpenPath: true })
    expect(hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', attachedSessions: 0, home: '/h', canOpenPath: false,
    }).provider).toBeUndefined()
    expect(() => hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', attachedSessions: 0,
    })).toThrow()
    expect(() => hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', attachedSessions: 0, canOpenPath: true,
    })).toThrow()
  })

  it('validates the browse listing/creation payloads', () => {
    expect(hostListDirectoryRequestSchema.parse({})).toEqual({})
    expect(hostListDirectoryRequestSchema.parse({ path: '/x' })).toEqual({ path: '/x' })
    const listing = hostListDirectoryValueSchema.parse({
      path: '/home/u/p',
      home: '/home/u',
      crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'p', path: '/home/u/p', hidden: false }],
      entries: [{ name: '.dot', path: '/home/u/p/.dot', hidden: true }],
      truncated: false,
    })
    expect(listing.entries[0]?.hidden).toBe(true)
    // The flag is part of the wire value, not an optional decoration.
    expect(() => hostListDirectoryValueSchema.parse({ path: '/x', home: '/x', crumbs: [], entries: [] })).toThrow()
    expect(hostCreateDirectoryRequestSchema.parse({ path: '/x', name: 'new' })).toEqual({ path: '/x', name: 'new' })
    for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b']) {
      expect(() => hostCreateDirectoryRequestSchema.parse({ path: '/x', name })).toThrow()
    }
    expect(hostCreateDirectoryValueSchema.parse({ path: '/x/new' })).toEqual({ path: '/x/new' })
  })
})

describe('skills domain schemas', () => {
  it('validates the list request/value pair', () => {
    expect(skillListRequestSchema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    // The wire is session-addressed only: a sessionId-less payload fails.
    expect(() => skillListRequestSchema.parse({})).toThrow()
    expect(skillListValueSchema.parse({ skills: [] }).skills).toEqual([])
    const value = skillListValueSchema.parse({ skills: [
      { name: 'commit-helper', description: 'Git commits', whenToUse: 'when committing', modelInvocable: true },
      { name: 'bare', description: 'No guidance', modelInvocable: false },
    ] })
    expect(value.skills[0]?.whenToUse).toBe('when committing')
    expect(value.skills[1]?.whenToUse).toBeUndefined()
    expect(value.skills[1]?.modelInvocable).toBe(false)
    expect(() => skillEntrySchema.parse({ name: '', description: 'd', modelInvocable: true })).toThrow()
    // modelInvocable is required wire data: an entry without it fails.
    expect(() => skillEntrySchema.parse({ name: 'n', description: 'd' })).toThrow()
  })
})

describe('agent-preset schemas', () => {
  it('answers the open-document union by its discriminant', () => {
    expect(agentPresetOpenDocumentValueSchema.parse({ opened: true })).toEqual({ opened: true })
    expect(agentPresetOpenDocumentValueSchema.parse({ opened: false, path: '/presets/mine' }))
      .toEqual({ opened: false, path: '/presets/mine' })
    // A closed reply must carry the path the surface shows instead.
    expect(() => agentPresetOpenDocumentValueSchema.parse({ opened: false })).toThrow()
  })
})
