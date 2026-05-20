<#
.SYNOPSIS
  Windows spawn helper for the Home Command Centre. The native-Windows
  counterpart to spawn-agent.sh (macOS).

.DESCRIPTION
  Opens a tiled Windows Terminal (wt.exe) window at a grid slot, running
  `claude --dangerously-skip-permissions` with an initial prompt read from a
  file. Registers the session in tools/dashboard/data/active-agents.json (via
  register-agent.cjs) so /api/agents can show it, and records the launcher
  process PID so the tracker can check liveness (process alive) and kill it
  (taskkill /T) without tmux.

  Liveness model (parity with macOS):
    macOS  : tmux session exists  == window open == alive
    Windows: launcher pwsh PID alive == window open == alive
  The launcher runs with -NoExit, so the hosting shell stays alive (PID stays
  valid) until the window/tab is closed; closing it ends the process and the
  tracker prunes the agent.

.NOTES
  Prompt safety: the prompt text NEVER travels on the wt/PowerShell command
  line (it could contain quotes, $, ;, newlines). A tiny launcher .ps1 reads it
  from the file as a single argument, exactly like the macOS launcher's
  "$(cat FILE)" trick. Only fixed tokens (paths, session) ride the command line.

  Requires: claude + node on PATH. Windows Terminal (wt) recommended for tiling;
  falls back to a plain PowerShell window if wt is absent.

  Prints the session name on stdout. Diagnostics go to stderr.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [int]$Slot = 1,
  [string]$Session = '',
  [string]$TodoText = '',
  [string]$Project = ''
)

$ErrorActionPreference = 'Stop'
function Fail($msg, $code = 2) { [Console]::Error.WriteLine("spawn-agent.ps1: $msg"); exit $code }
function Note($msg) { [Console]::Error.WriteLine("spawn-agent.ps1: $msg") }

# ---- Validate inputs -----------------------------------------------------
if (-not (Test-Path -LiteralPath $Cwd -PathType Container)) { Fail "cwd does not exist: $Cwd" }
if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) { Fail "prompt file does not exist: $PromptFile" }

if (-not $Session) {
  $Session = 'agentbrain-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
}
if ($Session -notmatch '^[a-zA-Z0-9_-]+$') { Fail "session name has invalid chars: $Session" }

# ---- Resolve dependencies ------------------------------------------------
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { Fail "claude CLI not found in PATH" 3 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "node not found in PATH" 3 }

$registerScript = Join-Path $PSScriptRoot 'register-agent.cjs'
if (-not (Test-Path -LiteralPath $registerScript -PathType Leaf)) { Fail "register-agent.cjs missing next to this script" 3 }

# Inner window shell: prefer PowerShell 7 (pwsh), fall back to Windows PowerShell.
$innerShell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $innerShell) { $innerShell = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $innerShell) { Fail "no PowerShell host (pwsh/powershell) found" 3 }

# ---- Grid position -------------------------------------------------------
# 4 cols x 2 rows, each window 1/8 of the primary screen. Fill top row
# left->right (slots 1-4), then bottom row (slots 5-8); 9th+ wraps to slot 1.
# Screen size auto-detected, env-overridable. wt --pos is pixels; wt --size is
# character cells, so we approximate cells from a per-char pixel estimate.
$gridCols = if ($env:GRID_COLS) { [int]$env:GRID_COLS } else { 4 }
$gridRows = if ($env:GRID_ROWS) { [int]$env:GRID_ROWS } else { 2 }

$mainW = if ($env:MAIN_SCREEN_W) { [int]$env:MAIN_SCREEN_W } else { 0 }
$mainH = if ($env:MAIN_SCREEN_H) { [int]$env:MAIN_SCREEN_H } else { 0 }
if ($mainW -le 0 -or $mainH -le 0) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($mainW -le 0) { $mainW = $b.Width }
    if ($mainH -le 0) { $mainH = $b.Height }
  } catch { }
}
if ($mainW -le 0) { $mainW = 1920 }
if ($mainH -le 0) { $mainH = 1080 }

$charW = if ($env:CHAR_W_PX) { [int]$env:CHAR_W_PX } else { 9 }
$charH = if ($env:CHAR_H_PX) { [int]$env:CHAR_H_PX } else { 19 }

# All of these must be plain integers — wt --pos/--size reject "480.0"-style
# tokens, and [math]::Floor returns [double].
$idx = ($Slot - 1) % ($gridCols * $gridRows)
$col = [int]($idx % $gridCols)
$row = [int][math]::Floor($idx / $gridCols)
$tileW = [int][math]::Floor($mainW / $gridCols)
$tileH = [int][math]::Floor($mainH / $gridRows)
$posX = [int]($col * $tileW)
$posY = [int]($row * $tileH)
$cols = [int][math]::Max(20, [math]::Floor($tileW / $charW))
$rows = [int][math]::Max(8, [math]::Floor(($tileH - 40) / $charH))  # leave room for the tab/title bar

# ---- Pre-register --------------------------------------------------------
# Record the agent BEFORE opening the window so /api/agents sees it
# immediately; the tracker prunes it if the process never comes up.
$regArgs = @($registerScript, '--session', $Session, '--slot', "$Slot", '--cwd', $Cwd, '--prompt-file', $PromptFile)
if ($TodoText) { $regArgs += @('--todo', $TodoText) }
if ($Project) { $regArgs += @('--project', $Project) }
& $node @regArgs | Out-Null

# ---- Build the inner launcher --------------------------------------------
# Writes its own PID to a pidfile (the liveness handle), cds to the working
# dir, reads the prompt as ONE argument, and execs claude. -NoExit keeps the
# window open afterwards so the PID == window-open.
$pidFile = Join-Path $env:TEMP "agentbrain-$Session.pid"
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }

# Escape single quotes for safe embedding in single-quoted PS literals.
function Q($s) { return ($s -replace "'", "''") }
$launcherBody = @"
Set-Content -LiteralPath '$(Q $pidFile)' -Value `$PID -Encoding ascii
Set-Location -LiteralPath '$(Q $Cwd)'
`$prompt = Get-Content -Raw -Encoding UTF8 -LiteralPath '$(Q $PromptFile)'
& '$(Q $claude)' --dangerously-skip-permissions `$prompt
"@

$launcher = Join-Path $env:TEMP ("agentbrain-launch-" + ([guid]::NewGuid().ToString('N').Substring(0, 8)) + ".ps1")
Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding UTF8

# ---- Window title --------------------------------------------------------
# Strip quotes / newlines / semicolons so the title can't break wt's
# command-line parsing (wt treats a standalone ';' as a tab/pane separator).
$titleLabel = if ($TodoText) { $TodoText } else { $Session }
$titleLabel = ($titleLabel -replace '[\r\n";]', ' ')
if ($titleLabel.Length -gt 44) { $titleLabel = $titleLabel.Substring(0, 44) }
$title = "$Slot`: $titleLabel"

# ---- Launch --------------------------------------------------------------
$wt = (Get-Command wt -ErrorAction SilentlyContinue).Source
if ($wt) {
  # Global window options (--pos/--size/--window) precede the subcommand.
  # The prompt is NOT here; only fixed paths/tokens, so wt's ';' splitting and
  # arg parsing can't break on prompt content.
  $wtArgs = @(
    '--window', 'new',
    '--pos', "$posX,$posY",
    '--size', "$cols,$rows",
    'new-tab', '--title', $title,
    $innerShell, '-NoLogo', '-NoExit', '-File', $launcher
  )
  & $wt @wtArgs | Out-Null
} else {
  Note "Windows Terminal (wt) not found; falling back to a plain PowerShell window (no tiling). Install it for the grid layout: winget install Microsoft.WindowsTerminal"
  Start-Process -FilePath $innerShell -ArgumentList @('-NoLogo', '-NoExit', '-File', $launcher) | Out-Null
}

# ---- Capture the launcher PID -------------------------------------------
# The launcher writes its PID once the window is up. Poll briefly, then record
# it. If it never appears (window failed to open), the pre-registered record
# will simply be pruned by the tracker on the next poll.
$thePid = $null
for ($i = 0; $i -lt 50; $i++) {
  if (Test-Path -LiteralPath $pidFile) {
    $thePid = (Get-Content -Raw -LiteralPath $pidFile).Trim()
    if ($thePid) { break }
  }
  Start-Sleep -Milliseconds 100
}
if ($thePid) {
  & $node $registerScript '--session' $Session '--pid' $thePid | Out-Null
} else {
  Note "launcher PID file did not appear within 5s; liveness/kill may be degraded for $Session"
}

Write-Output $Session
