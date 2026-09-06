import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8')) as {
  jobs: Record<string, { 'runs-on': string; steps: Array<{ name?: string; id?: string; uses?: string; if?: string; shell?: string; run?: string; with?: Record<string, unknown> }> }>
}
const build = workflow.jobs.build!
const selector = build['runs-on'].slice(3, -2).trim()
const windows = ['self-hosted', 'dsh-win-ci', 'windows', 'x64']

function context() {
  return {
    inputs: { ci: true, release: false },
    github: {
      repository: 'deepseek-harness/deepseek-harness',
      event_name: 'pull_request',
      ref: 'refs/pull/42/merge',
      event: { pull_request: {
        head: { repo: { full_name: 'deepseek-harness/deepseek-harness', fork: false } },
        user: { login: 'contributor' },
      } },
    },
    matrix: { target: 'node24-win-x64', runner: 'windows-2025' },
    vars: { DSH_CI_FAILOVER_WINDOWS: 'selfhosted' },
    fromJSON: JSON.parse,
  }
}

function route(value: ReturnType<typeof context>, expression = selector): unknown {
  // These canonical-case fixtures share JS/Actions comparison results; Actions also ignores string case.
  // This evaluates the selected syntax, not GitHub's complete expression language.
  return runInNewContext(expression, value, { timeout: 1000 })
}

describe('Python runtime self-hosted routing', () => {
  it('routes same-repository member PRs to native x64 Windows', () => {
    expect(route(context())).toEqual(windows)
  })

  it.each([
    ['release caller', (value: ReturnType<typeof context>) => { value.inputs.release = true }],
    ['non-CI caller', (value: ReturnType<typeof context>) => { value.inputs.ci = false }],
    ['manual dispatch', (value: ReturnType<typeof context>) => { value.github.event_name = 'workflow_dispatch' }],
    ['pull_request_target', (value: ReturnType<typeof context>) => { value.github.event_name = 'pull_request_target' }],
    ['unknown event', (value: ReturnType<typeof context>) => { value.github.event_name = '' }],
    ['fork', (value: ReturnType<typeof context>) => { value.github.event.pull_request.head.repo.fork = true }],
    ['different repository head', (value: ReturnType<typeof context>) => { value.github.event.pull_request.head.repo.full_name = 'someone/fork' }],
    ['different caller repository', (value: ReturnType<typeof context>) => { value.github.repository = 'someone/fork' }],
    ['Dependabot author', (value: ReturnType<typeof context>) => { value.github.event.pull_request.user.login = 'dependabot[bot]' }],
    ['disabled failover', (value: ReturnType<typeof context>) => { value.vars.DSH_CI_FAILOVER_WINDOWS = '' }],
    ['unknown failover value', (value: ReturnType<typeof context>) => { value.vars.DSH_CI_FAILOVER_WINDOWS = 'hosted' }],
    ['master push', (value: ReturnType<typeof context>) => { value.github.event_name = 'push'; value.github.ref = 'refs/heads/master' }],
    ['branch push', (value: ReturnType<typeof context>) => { value.github.event_name = 'push'; value.github.ref = 'refs/heads/topic' }],
    ['tag push', (value: ReturnType<typeof context>) => { value.github.event_name = 'push'; value.github.ref = 'refs/tags/python-v1' }],
  ] as const)('keeps %s on the hosted fallback', (_name, change) => {
    const value = context()
    change(value)
    expect(route(value)).toBe('windows-2025')
  })

  it.each([
    ['node24-linux-x64', 'ubuntu-latest'],
    ['node24-linux-arm64', 'ubuntu-24.04-arm'],
    ['node24-macos-arm64', 'macos-latest'],
    ['node24-macos-x64', 'macos-15-intel'],
  ])('keeps %s hosted even with failover enabled', (target, runner) => {
    const value = context()
    value.matrix = { target, runner }
    expect(route(value)).toBe(runner)
  })

  it('keeps setup helper jobs on hosted images', () => {
    expect(workflow.jobs.plan!['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs['sdk-wheel']!['runs-on']).toBe('ubuntu-latest')
  })

  it('isolates setup before pnpm and excludes shared installers and cache archives', () => {
    const privateSetup = build.steps.findIndex(step => step.id === 'private-windows')
    expect(privateSetup).toBeGreaterThan(0)
    expect(privateSetup).toBeLessThan(build.steps.findIndex(step => step.uses?.startsWith('pnpm/action-setup@')))
    for (const step of build.steps.filter(step => step.uses?.startsWith('actions/setup-python@') || step.uses?.startsWith('actions/cache@') || step.name === 'Install Python build tooling')) {
      expect(step.if).toBe("runner.environment != 'self-hosted'")
    }
    expect(build.steps.find(step => step.name?.startsWith('Enable Windows'))?.if).toBe("runner.os == 'Windows' && runner.environment != 'self-hosted'")
    expect(build.steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.cache).toContain("runner.environment != 'self-hosted'")
    expect(build.steps.at(-1)).toMatchObject({ if: "always() && steps.private-windows.outputs.root != ''", shell: 'pwsh' })
    expect(build.steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['package-manager-cache']).toBe(false)
    expect(build.steps.find(step => step.name === 'Install (immutable)')?.if).toBe("runner.environment != 'self-hosted'")
    expect(build.steps.find(step => step.name === 'Install private Windows dependencies (immutable)')).toMatchObject({
      if: "runner.os == 'Windows' && runner.environment == 'self-hosted'",
      shell: 'pwsh',
    })
    expect(build.steps.find(step => step.name === 'Install private Windows dependencies (immutable)')?.run).toContain('pnpm install --frozen-lockfile --package-import-method=copy')
    const cleanup = build.steps.at(-1)!.run!
    expect(cleanup).toContain('"NODE_COMPILE_CACHE=" >> $env:GITHUB_ENV')
    expect(cleanup).toContain('"TMP=$env:RUNNER_TEMP" >> $env:GITHUB_ENV')
    expect(cleanup).toContain('"TEMP=$env:RUNNER_TEMP" >> $env:GITHUB_ENV')
    expect(cleanup).toContain('maxRetries: 10, retryDelay: 100')
  })

  it.each(['root', 'nested', 'absent'] as const)('cleans a %s job directory without deleting another target', (location) => {
    const temp = mkdtempSync(resolve(tmpdir(), 'python-runtime-cleanup-'))
    try {
      const target = resolve(temp, 'other-job')
      const owned = resolve(temp, 'owned')
      mkdirSync(target)
      writeFileSync(resolve(target, 'sentinel'), 'preserve')
      if (location === 'nested') mkdirSync(owned)
      if (location !== 'absent') symlinkSync(target, location === 'root' ? owned : resolve(owned, 'link'), 'junction')
      const command = /node -e "([^"\n]+)"/.exec(build.steps.at(-1)!.run!)?.[1]
      expect(command).toBeDefined()
      const result = spawnSync(process.execPath, ['-e', command!], {
        env: { ...process.env, PRIVATE_ROOT: owned, NODE_COMPILE_CACHE: '' },
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(owned)).toBe(false)
      expect(readFileSync(resolve(target, 'sentinel'), 'utf8')).toBe('preserve')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('reads UTF-8 Session JSONL independently of the host locale', () => {
    const setup = readFileSync(resolve(root, 'scripts/setup-python-runtime-windows.ps1'), 'utf8')
    const utf8 = /PYTHONUTF8 = '([^']+)'/.exec(setup)?.[1]
    expect(utf8).toBe('1')
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', [
      'import pathlib, tempfile, sys',
      'assert sys.flags.utf8_mode == 1',
      'with tempfile.TemporaryDirectory(prefix="python-runtime-encoding-") as root:',
      '    log = pathlib.Path(root) / "session.jsonl"',
      '    text = chr(0x2014) + chr(0x4e2d)',
      '    log.write_bytes(text.encode("utf-8"))',
      '    assert log.read_text() == text',
    ].join('\n')], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', PYTHONCOERCECLOCALE: '0', PYTHONUTF8: utf8 },
      encoding: 'utf8',
      timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
  })

  it('pins portable Python without registry or shared cache writes', () => {
    const setup = readFileSync(resolve(root, 'scripts/setup-python-runtime-windows.ps1'), 'utf8')
    expect(setup).toContain('--no-bin --no-registry 3.10')
    expect(setup).toContain('--managed-python --no-python-downloads --seed')
    expect(setup).toContain('UV_PYTHON_INSTALL_REGISTRY')
    expect(setup).toContain('PNPM_CONFIG_STORE_DIR')
    expect(setup).toContain('PKG_CACHE_PATH')
    expect(setup.indexOf('$bootstrapScripts >> $env:GITHUB_PATH')).toBeLessThan(setup.indexOf('$toolingScripts >> $env:GITHUB_PATH'))
    expect(setup).toContain('AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue')
    expect(setup).toContain('$null -eq $devMode -or')
    expect(setup).not.toMatch(/reg add|Set-ItemProperty|InstallAllUsers/)
  })
})
