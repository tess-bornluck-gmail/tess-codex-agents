<#
.SYNOPSIS
Launch Chrome with a persistent isolated profile and a local CDP endpoint.
.EXAMPLE
.\start-chrome.ps1
.EXAMPLE
.\start-chrome.ps1 -Port 19224 -Url https://teams.microsoft.com
.EXAMPLE
.\start-chrome.ps1 -ChromePath 'D:\Apps\Chrome\chrome.exe' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 19223,
    [string]$ChromePath,
    [string]$Url = 'about:blank',
    [switch]$Headless,
    [ValidateRange(1, 120)]
    [int]$TimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profilePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "isolated-$Port"))
$endpoint = "http://127.0.0.1:$Port/json/version"

if ($Url -match '["\r\n]' -or $Url -notmatch '^(https?://|about:|chrome://)') {
    throw 'Url must be an http, https, about, or chrome URL without double quotes or newlines.'
}

if (-not $ChromePath) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $ChromePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $ChromePath) {
        $chromeCommand = Get-Command chrome.exe -ErrorAction SilentlyContinue
        if ($chromeCommand) { $ChromePath = $chromeCommand.Source }
    }
}
if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
    throw 'Chrome was not found. Provide -ChromePath with the full path to chrome.exe.'
}
$ChromePath = (Resolve-Path -LiteralPath $ChromePath).Path

# Match the exact dedicated user-data directory, never a personal Chrome profile.
$profilePattern = '(?i)(?:^|\s)"?--user-data-dir=(?:"' + [regex]::Escape($profilePath) + '"|' + [regex]::Escape($profilePath) + ')(?:\s|$)'
$portPattern = '(?:^|\s)--remote-debugging-port=' + $Port + '(?:\s|$)'
$chromeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
$profileProcesses = @($chromeProcesses | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $profilePattern
})
$listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port })

if ($listeners.Count -gt 0) {
    $matching = @($profileProcesses | Where-Object { $_.CommandLine -match $portPattern })
    if ($matching.Count -eq 0) {
        throw "Port $Port is already in use by another process or profile. Choose a different -Port."
    }
    try {
        $version = Invoke-RestMethod -Uri $endpoint -TimeoutSec 2
        if (-not $version.webSocketDebuggerUrl) { throw 'No browser WebSocket endpoint returned.' }
    } catch {
        throw "Port $Port is in use, but its CDP endpoint is unavailable: $($_.Exception.Message)"
    }
    Write-Output "Reusing Chrome on port $Port. No new URL was opened."
    Write-Output "Profile: $profilePath"
    Write-Output "CDP: $endpoint"
    return
}
if ($profileProcesses.Count -gt 0) {
    throw "The profile '$profilePath' is already running without a reachable CDP endpoint on port $Port. Close that instance before retrying."
}

$chromeArguments = @(
    "--remote-debugging-port=$Port"
    '--remote-debugging-address=127.0.0.1'
    ('--user-data-dir="{0}"' -f $profilePath)
    '--profile-directory=Default'
    '--no-first-run'
    '--no-default-browser-check'
)
if ($Headless) { $chromeArguments += @('--headless=new', '--window-size=1280,900') }
$chromeArguments += ('"{0}"' -f $Url)

if (-not $PSCmdlet.ShouldProcess($profilePath, "Start Chrome with CDP on port $Port; URL $Url")) { return }
New-Item -ItemType Directory -Path $profilePath -Force | Out-Null

# The normal mode is intentionally visible for browsing and interactive sign-in.
$launchOptions = @{ FilePath = $ChromePath; ArgumentList = $chromeArguments; PassThru = $true }
if ($Headless) { $launchOptions.WindowStyle = 'Hidden' }
$chromeProcess = Start-Process @launchOptions
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    try {
        $version = Invoke-RestMethod -Uri $endpoint -TimeoutSec 1
        if ($version.webSocketDebuggerUrl) {
            Write-Output "Chrome CDP is ready on port $Port ($($version.Browser))."
            Write-Output "Profile: $profilePath"
            Write-Output "CDP: $endpoint"
            return
        }
    } catch {
        # Startup may take several polls; keep each network attempt bounded.
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

throw "Chrome was launched (PID $($chromeProcess.Id)), but CDP did not become ready at $endpoint within $TimeoutSeconds seconds. The profile was preserved at '$profilePath'."
