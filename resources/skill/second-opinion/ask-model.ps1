# Ask a non-Claude model through the local claude-code-router gateway.
# Usage:
#   ask-model.ps1 -List
#   ask-model.ps1 -Model "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free" -PromptFile path\to\prompt.md
#   ask-model.ps1 -Model "<id>" -Prompt "short question"
param(
    [string]$Model = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    [string]$Prompt,
    [string]$PromptFile,
    [int]$MaxTokens = 4000,
    [switch]$List
)
$ErrorActionPreference = 'Stop'
$gateway = 'http://127.0.0.1:3456'

if (-not (Test-NetConnection 127.0.0.1 -Port 3456 -WarningAction SilentlyContinue).TcpTestSucceeded) {
    ccr start --no-open | Out-Null
}

$helper = Join-Path $env:APPDATA 'claude-code-router\bin\ccr-claude-code-api-key-default-claude-code.cmd'
$key = (& $helper | Select-Object -Last 1).Trim()
$headers = @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' }

if ($List) {
    (Invoke-RestMethod -Uri "$gateway/v1/models" -Headers $headers).data.id
    return
}

if ($PromptFile) { $Prompt = Get-Content $PromptFile -Raw -Encoding UTF8 }
if (-not $Prompt) { throw 'Pass -Prompt or -PromptFile.' }

$body = @{
    model      = $Model
    max_tokens = $MaxTokens
    messages   = @(@{ role = 'user'; content = $Prompt })
} | ConvertTo-Json -Depth 6

try {
    $r = Invoke-RestMethod -Method Post -Uri "$gateway/v1/messages" -Headers $headers `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 300
    ($r.content | Where-Object type -eq 'text').text -join "`n"
} catch {
    $detail = try { ($_.ErrorDetails.Message | ConvertFrom-Json).error.attempts[0] } catch { $null }
    if ($detail) { "ERROR $($detail.status): $($detail.details.error.message)$($detail.message)" } else { "ERROR: $($_.Exception.Message)" }
    exit 1
}
