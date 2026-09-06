# Prepare a job-private Python 3.10 toolchain without Windows installer or registry writes.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP ("python-runtime-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
"root=$root" >> $env:GITHUB_OUTPUT

$privateEnvironment = @{
  TMP = $root
  TEMP = $root
  UV_CACHE_DIR = (Join-Path $root 'uv-cache')
  UV_PYTHON_INSTALL_DIR = (Join-Path $root 'python')
  UV_PYTHON_INSTALL_BIN = '0'
  UV_PYTHON_INSTALL_REGISTRY = '0'
  UV_NO_CONFIG = '1'
  PIP_CACHE_DIR = (Join-Path $root 'pip-cache')
  npm_config_cache = (Join-Path $root 'npm-cache')
  npm_config_devdir = (Join-Path $root 'node-gyp')
  PNPM_CONFIG_PACKAGE_IMPORT_METHOD = 'copy'
  PKG_CACHE_PATH = (Join-Path $root 'pkg-cache')
  PNPM_CONFIG_STORE_DIR = (Join-Path $root 'pnpm-store')
  NODE_COMPILE_CACHE = (Join-Path $root 'node-compile-cache')
}
foreach ($entry in $privateEnvironment.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  "$($entry.Key)=$($entry.Value)" >> $env:GITHUB_ENV
}

if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'Python runtime CI requires a native x64 Windows host.'
}
$devMode = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense
if ($devMode.AllowDevelopmentWithoutDevLicense -ne 1) {
  throw 'The self-hosted Windows image must enable Developer Mode before CI.'
}

$bootstrap = Join-Path $root 'bootstrap'
python -m venv $bootstrap
if ($LASTEXITCODE -ne 0) { throw 'The self-hosted Windows image requires Python with venv and ensurepip.' }
$bootstrapScripts = Join-Path $bootstrap 'Scripts'
& (Join-Path $bootstrapScripts 'python.exe') -m pip --isolated --disable-pip-version-check --no-cache-dir install uv==0.11.23
if ($LASTEXITCODE -ne 0) { throw 'Job-private uv installation failed.' }
$uv = Join-Path $bootstrapScripts 'uv.exe'
& $uv python install --install-dir $env:UV_PYTHON_INSTALL_DIR --no-bin --no-registry 3.10
if ($LASTEXITCODE -ne 0) { throw 'Job-private Python 3.10 download failed.' }
$tooling = Join-Path $root 'tooling'
& $uv venv --python 3.10 --managed-python --no-python-downloads --seed $tooling
if ($LASTEXITCODE -ne 0) { throw 'Job-private Python 3.10 environment creation failed.' }
$toolingScripts = Join-Path $tooling 'Scripts'
$python = Join-Path $toolingScripts 'python.exe'
& $python -c 'import platform, sys; assert sys.version_info[:2] == (3, 10); assert platform.machine() == "AMD64"; print(sys.version); print(sys.executable)'
if ($LASTEXITCODE -ne 0) { throw 'Job-private Python version or architecture is incorrect.' }
$bootstrapScripts >> $env:GITHUB_PATH
$toolingScripts >> $env:GITHUB_PATH
