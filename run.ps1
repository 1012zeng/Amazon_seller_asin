$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'src\cli.ts'
$tsx = Join-Path $PSScriptRoot 'node_modules\tsx\dist\loader.mjs'
if (-not (Test-Path -LiteralPath $tsx)) { throw '请先在独立项目目录运行 pnpm install --frozen-lockfile' }
$node = (Get-Command node -ErrorAction Stop).Source
Push-Location $PSScriptRoot
try {
  & $node --expose-gc --import ([System.Uri]::new($tsx).AbsoluteUri) $entry @args
  $result = $LASTEXITCODE
} finally { Pop-Location }
exit $result
