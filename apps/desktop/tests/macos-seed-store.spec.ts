import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Packr } from 'msgpackr'
import { afterEach, describe, expect, it } from 'vitest'
import {
  signMacOSSeedStore,
  verifyMacOSSeedStore,
} from '../scripts/macos-seed-store.ts'

const temporaryRoots: string[] = []
const packr = new Packr({ moreTypes: true, useRecords: true })
const SIGNING_ENVIRONMENT = {
  signingIdentity: 'Example Company (TEAMID1234)',
  teamId: 'TEAMID1234',
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-signing-test-'))
  temporaryRoots.push(root)
  return root
}

function casPath(store: string, body: Buffer, executable = false): { digest: string; path: string } {
  const digest = createHash('sha512').update(body).digest('hex')
  return {
    digest,
    path: join(store, 'v11', 'files', digest.slice(0, 2), `${digest.slice(2)}${executable ? '-exec' : ''}`),
  }
}

function createStoreFile(path: string, body: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop macOS seed store signing', () => {
  it('rehashes signed Mach-O content, rewrites every package reference, and prunes native orphans', () => {
    const store = temporaryRoot()
    const native = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('native-code')])
    const nativeCas = casPath(store, native)
    createStoreFile(nativeCas.path, native)
    const orphan = Buffer.concat([Buffer.from('cafebabe', 'hex'), Buffer.from('orphan')])
    const orphanCas = casPath(store, orphan)
    createStoreFile(orphanCas.path, orphan)
    const plain = Buffer.from('plain package content')
    const plainCas = casPath(store, plain)
    createStoreFile(plainCas.path, plain)

    const database = new DatabaseSync(join(store, 'v11', 'index.db'))
    database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
    const insert = database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
    for (const key of ['package-a', 'package-b']) {
      insert.run(key, packr.pack({
        algo: 'sha512',
        files: new Map([
          ['native.node', { checkedAt: 1, digest: nativeCas.digest, mode: 0o644, size: native.length }],
          ['index.js', { checkedAt: 1, digest: plainCas.digest, mode: 0o644, size: plain.length }],
        ]),
        sideEffects: key === 'package-b'
          ? new Map([['build', { added: new Map([
            ['built/native.node', { checkedAt: 1, digest: nativeCas.digest, mode: 0o644, size: native.length }],
          ]) }]])
          : undefined,
      }))
    }
    database.close()

    const result = signMacOSSeedStore(
      store,
      'com.example.desktop',
      SIGNING_ENVIRONMENT,
      (path, identifier) => {
        expect(identifier).toBe(`com.example.desktop.seed.${nativeCas.digest.slice(0, 32)}`)
        appendFileSync(path, 'signed')
      },
    )

    expect(result).toEqual({ signedFiles: 1, prunedOrphans: 1, updatedIndexRows: 2 })
    expect(existsSync(nativeCas.path)).toBe(false)
    expect(existsSync(orphanCas.path)).toBe(false)
    expect(readFileSync(plainCas.path)).toEqual(plain)

    const updated = new DatabaseSync(join(store, 'v11', 'index.db'), { readOnly: true })
    const digests = [...updated.prepare('SELECT data FROM package_index').iterate() as Iterable<{ data: Uint8Array }>]
      .flatMap((row) => {
        const record = packr.unpack(row.data) as {
          files: Map<string, { digest: string }>
          sideEffects?: Map<string, { added: Map<string, { digest: string }> }>
        }
        return [
          record.files.get('native.node')?.digest,
          ...[...(record.sideEffects?.values() ?? [])].map(effect => effect.added.get('built/native.node')?.digest),
        ].filter((digest): digest is string => digest !== undefined)
      })
    updated.close()
    expect(new Set(digests).size).toBe(1)
    expect(digests).toHaveLength(3)
    expect(digests[0]).not.toBe(nativeCas.digest)

    const verified: string[] = []
    expect(verifyMacOSSeedStore(store, SIGNING_ENVIRONMENT, (path) => { verified.push(path) })).toBe(1)
    expect(verified).toHaveLength(1)
  })

  it('propagates a signature-verification failure', () => {
    const store = temporaryRoot()
    const native = Buffer.concat([Buffer.from('feedfacf', 'hex'), Buffer.from('native-code')])
    const nativeCas = casPath(store, native)
    createStoreFile(nativeCas.path, native)

    expect(() => {
      verifyMacOSSeedStore(store, SIGNING_ENVIRONMENT, () => {
        throw new Error('invalid signature')
      })
    }).toThrow(/invalid signature/u)
  })
})
