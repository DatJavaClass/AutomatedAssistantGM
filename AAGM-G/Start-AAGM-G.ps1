$ErrorActionPreference = 'Stop'

$projectPath = $PSScriptRoot
$relayPath = Join-Path $projectPath 'relay'
$runtimePath = Join-Path ([System.IO.Path]::GetTempPath()) 'AAGM-G'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null

function Show-AagmMessage([string]$message, [int]$icon = 64) {
  $shell = New-Object -ComObject WScript.Shell
  $shell.Popup($message, 8, 'AAGM-G', $icon) | Out-Null
}

try {
  $relayPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 7890, 7891 }

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

  Show-AagmMessage "AAGM-G relay is up on 7890 and 7891.`n`nOpen Grok and use relay/LISTENER_PROMPT.md for /int.`n/ext uses the same MCP tools from outside Foundry."
} catch {
  Show-AagmMessage "AAGM-G failed to start.`n`n$($_.Exception.Message)" 16
  exit 1
}
