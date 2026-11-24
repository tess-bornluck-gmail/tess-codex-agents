<#
  Close a native file dialog that a browser has already put on screen.

  This is the cure, and `Page.setInterceptFileChooserDialog` is the prevention;
  every cdp.mjs command turns that on, so this exists for the dialog opened
  before any of it was in place — by a person clicking, or by a command from a
  build that predates the interception.

  It is NOT SendKeys. Sending {ESC} means first dragging a window to the
  foreground and then hoping: if activation misses, Escape lands in whatever
  the person was actually typing in, and a tool whose failure mode is "cancels
  your unsaved work somewhere else" is worse than one that does nothing. UI
  Automation closes the dialog in place, with no focus change at all.

  UIAutomationClient is managed code. A `[DllImport(` in
  a PowerShell file next to window-poking code is the shape antivirus
  signatures are written for, and Defender blocks at *parse* time — the script
  would not run at all, and nothing could say why.

  Two things here were measured rather than assumed, and both were wrong first
  time round on Windows 10 with pwsh 7.6:

    - **A file dialog is not a top-level window.** It is *owned* by the window
      that opened it, and an owned window is not a child of the desktop in the
      UIA tree — it is a descendant of its owner. Searching the desktop's
      children finds every ordinary window and never finds the dialog.
    - **There is no Cancel button to press.** The modern common item dialog
      exposes Help, Organize, New folder, a view slider, filter dropdowns and
      search — and neither `Cancel` by name nor `IDCANCEL` (`AutomationId` 2)
      is among them. `WindowPattern.Close()` is what works, and it is better
      anyway: it is the same thing as the title bar's cross, so the dialog
      cancels itself through its own code path. Chrome reports it as an
      ordinary dismissal, exactly as Escape would.
#>
param([int]$OwnerPid = 0)
$ErrorActionPreference = 'Stop'

function Write-Answer($value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 4))
  exit 0
}

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
} catch {
  Write-Answer @{ ok = $false; error = 'no_ui_automation'; detail = $_.Exception.Message }
}

$auto = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]

# Only this browser's dialogs. Another application's "New version available" is
# a `#32770` too, and closing somebody's unrelated dialog because it shares a
# window class is the kind of help nobody asks for twice.
$owners = @(Get-Process -Name 'chrome' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($OwnerPid -gt 0) { $owners = @($OwnerPid) }
if ($owners.Count -eq 0) { Write-Answer @{ ok = $true; closed = 0; titles = @(); detail = 'no chrome process is running' } }

$windowCond = New-Object System.Windows.Automation.PropertyCondition(
  $auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)

$closed = @()
$seen = 0
foreach ($top in $auto::RootElement.FindAll($scope::Children, $windowCond)) {
  if ($owners -notcontains $top.Current.ProcessId) { continue }

  # The owner itself is never the dialog — a browser window is not a `#32770` —
  # but searching from it is the only way to reach the one it owns.
  foreach ($dialog in $top.FindAll($scope::Descendants, $windowCond)) {
    if ($dialog.Current.ClassName -ne '#32770') { continue }
    $seen++
    $title = $dialog.Current.Name
    try {
      $dialog.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
      $closed += $title
    } catch {
      # The dialog going away between finding it and closing it is the thing
      # being asked for, not a failure.
    }
  }
}

Write-Answer @{ ok = $true; closed = $closed.Count; titles = @($closed); dialogs = $seen }
