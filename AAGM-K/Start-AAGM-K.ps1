$ErrorActionPreference = 'Stop'

$projectPath = $PSScriptRoot
$relayPath = Join-Path $projectPath 'relay'
$promptPath = Join-Path $relayPath 'LISTENER_PROMPT.md'
$runtimePath = Join-Path ([System.IO.Path]::GetTempPath()) 'AAGM-K'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null

function Show-AagmMessage([string]$message, [int]$icon = 64) {
  $shell = New-Object -ComObject WScript.Shell
  $shell.Popup($message, 6, 'AAGM-K', $icon) | Out-Null
}

try {
  $relayPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 7898, 7899 } ## keeps relay ports only

  if (($relayPorts | Select-Object -ExpandProperty LocalPort -Unique).Count -lt 2) { ## missing port starts relay, both skip
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    Start-Process -FilePath $nodePath `
      -ArgumentList 'index.js' `
      -WorkingDirectory $relayPath `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtimePath 'relay-stdout.log') `
      -RedirectStandardError (Join-Path $runtimePath 'relay-stderr.log')
    Start-Sleep -Seconds 2
  }

  $listener = Get-CimInstance Win32_Process |
    Where-Object { ## kimi listener processes only
      $_.Name -match '^kimi(\.exe)?$' -and
      $_.CommandLine -match 'mcp__aagm-k__'
    }

  if (-not $listener) { ## no listener starts kimi, else skips
    $kimiPath = (Get-Command kimi -ErrorAction Stop).Source
    $env:KIMI_MCP_TOOL_TIMEOUT_MS = '330000'
    $prompt = Get-Content -Path $promptPath -Raw
    Start-Process -FilePath $kimiPath `
      -ArgumentList @('-p', ('"' + ($prompt -replace '"', '\"') + '"')) `
      -WorkingDirectory $projectPath `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtimePath 'listener-stdout.log') `
      -RedirectStandardError (Join-Path $runtimePath 'listener-stderr.log')
  }

  Show-AagmMessage 'AAGM-K relay and listener started.'
} catch {
  Show-AagmMessage "AAGM-K failed to start.`n`n$($_.Exception.Message)" 16
  exit 1
}
