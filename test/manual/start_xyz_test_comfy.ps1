param(
    [ValidateSet('Start', 'Restart', 'Stop')][string]$Action = 'Start',
    [ValidateRange(1024, 65535)][int]$Port = 8190,
    [switch]$UseGpu
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$comfyRoot = Split-Path (Split-Path $repoRoot -Parent) -Parent
$installRoot = Split-Path $comfyRoot -Parent
$pythonPath = [IO.Path]::GetFullPath((Join-Path $installRoot 'python/python.exe'))
$testRoot = Join-Path $installRoot 'XYZNodes-Test'
$statePath = Join-Path $testRoot 'instance.json'
$url = "http://127.0.0.1:$Port"
$existing = $null
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
    if ($existing) {
        $expectedRoot = [regex]::Escape($testRoot)
        $commandLine = $existing.CommandLine.Replace('"', '').Replace('/', '\')
        if ($existing.ExecutablePath -ne $pythonPath -or $commandLine -notmatch "--base-directory\s+$expectedRoot(\s|$)" -or $commandLine -notmatch "--port\s+$($state.port)(\s|$)") {
            throw 'Saved PID belongs to a different process; refusing to stop it.'
        }
    }
}
if ($Action -eq 'Stop' -or $Action -eq 'Restart') {
    if ($existing) {
        Stop-Process -Id $existing.ProcessId
        Wait-Process -Id $existing.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        $existing = $null
    }
    if ($Action -eq 'Stop') { Write-Output 'XYZNodes test instance stopped.'; exit 0 }
}
if ($existing) {
    Write-Output "XYZNodes test instance already running: http://127.0.0.1:$($state.port)"
    exit 0
}
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use; no existing service was stopped." }
& $pythonPath (Join-Path $PSScriptRoot 'prepare_xyz_test_comfy.py') $testRoot
if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare isolated XYZNodes copy.' }
$stdout = Join-Path $testRoot 'logs/comfy-out.log'
$stderr = Join-Path $testRoot 'logs/comfy-err.log'
$arguments = @(
    (Join-Path $comfyRoot 'main.py'), '--disable-auto-launch', '--listen', '127.0.0.1',
    '--port', "$Port", '--base-directory', $testRoot,
    '--temp-directory', (Join-Path $testRoot 'temp'),
    '--models-directory', (Join-Path $comfyRoot 'models'),
    '--disable-all-custom-nodes', '--whitelist-custom-nodes', 'ComfyUI-XYZNodes'
)
if (-not $UseGpu) { $arguments += '--cpu' }
# Start-Process joins ArgumentList; quote every path so spaces remain intact.
$quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
$started = Start-Process -FilePath $pythonPath -ArgumentList $quotedArguments -WorkingDirectory $comfyRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
@{ pid = $started.Id; port = $Port; root = $testRoot; gpu = [bool]$UseGpu } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Output "Starting XYZNodes-only ComfyUI (PID $($started.Id)): $url"
$deadline = (Get-Date).AddSeconds(55)
while ((Get-Date) -lt $deadline) {
    if ($started.HasExited) { throw "ComfyUI exited. See $stderr" }
    try {
        $response = Invoke-WebRequest -Uri "$url/object_info" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { Write-Output "Ready: $url"; exit 0 }
    } catch { }
    Start-Sleep -Milliseconds 400
}
Write-Output "Still starting. See $stderr; the test process remains running."
