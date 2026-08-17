$ErrorActionPreference = 'Stop'

$projectPath = $PSScriptRoot
$relayPath = Join-Path $projectPath 'relay'
$promptPath = Join-Path $relayPath 'LISTENER_PROMPT.md'
$runtimePath = Join-Path ([System.IO.Path]::GetTempPath()) 'AAGM-O'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null

function Show-AagmMessage([string]$message, [int]$icon = 64) {
  $shell = New-Object -ComObject WScript.Shell
  $shell.Popup($message, 6, 'AAGM-O', $icon) | Out-Null
}

try {
  $relayPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 7888, 7889 }

  if (($relayPorts | Select-Object -ExpandProperty LocalPort -Unique).Count -lt 2) {
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
    Where-Object {
      $_.Name -match '^codex(\.exe)?$' -and
      $_.CommandLine -match 'mcp_servers\.aagm-o\.tool_timeout_sec'
    }

  if (-not $listener) {
    $codexPath = (Get-Command codex -ErrorAction Stop).Source
    $arguments = @(
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--ephemeral',
      '-c',
      'mcp_servers.aagm-o.default_tools_approval_mode=approve',
      '-c',
      'mcp_servers.aagm-o.tool_timeout_sec=90',
      '-'
    )
    Start-Process -FilePath $codexPath `
      -ArgumentList $arguments `
      -WorkingDirectory $projectPath `
      -WindowStyle Hidden `
      -RedirectStandardInput $promptPath `
      -RedirectStandardOutput (Join-Path $runtimePath 'listener-stdout.jsonl') `
      -RedirectStandardError (Join-Path $runtimePath 'listener-stderr.log')
  }

  Show-AagmMessage 'AAGM-O relay and listener started.'
} catch {
  Show-AagmMessage "AAGM-O failed to start.`n`n$($_.Exception.Message)" 16
  exit 1
}
