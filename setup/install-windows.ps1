<#
  Stream Studio installer for Windows 10 and 11.

  Easiest: double-click Install-Windows.bat. Or paste this into PowerShell:
    irm https://raw.githubusercontent.com/saorinchin79/camera-live-screen-project/main/setup/install-windows.ps1 | iex

  It asks for the installation password, then installs into %USERPROFILE%\StreamStudio and needs
  no administrator rights:
    1. copies Stream Studio there (from the folder around this script, or downloaded from GitHub)
    2. uses Node.js 18+ if this PC has it, otherwise downloads Node.js LTS into StreamStudio\runtime\node
    3. installs the npm packages, including ffmpeg for the CCTV cameras
    4. adds "Stream Studio" to the desktop and the Start menu, and on request starts it at log-in
  Running it again updates Stream Studio and keeps the layout, the cameras and the uploads.

  Options: -InstallDir <folder>  -AutoStart / -NoAutoStart  -NoStart (do not offer to start it at the end)
  STREAM_STUDIO_ARCHIVE=<url of a .zip> installs from another copy of the project instead of GitHub.
#>
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'StreamStudio'),
  [switch]$AutoStart,
  [switch]$NoAutoStart,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times faster without its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'saorinchin79/camera-live-screen-project'
$Branch = 'main'
$MinNode = 18

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Info([string]$text) { Write-Host "    $text" }
function Warn([string]$text) { Write-Host "    $text" -ForegroundColor Yellow }

function Ask([string]$question, [string]$default) {
  try { $answer = Read-Host "    $question" } catch { $answer = '' }
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer
}

function New-TempDir {
  $dir = Join-Path $env:TEMP ('stream-studio-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $dir | Out-Null
  return $dir
}

function Expand-Zip([string]$zip, [string]$dest) {
  # tar.exe (Windows 10 1803 and later) unpacks far faster than Expand-Archive
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    & $tar -xf $zip -C $dest
    if ($LASTEXITCODE -eq 0) { return }
  }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
}

function Get-NodeMajor([string]$exe) {
  try {
    $version = & $exe --version
    if ($version -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

# ---------- password ----------

# The script is public, so it keeps only a PBKDF2-SHA256 hash of the installation password. To change it, run
#   node -e "const c = require('crypto'), s = c.randomBytes(16); console.log(s.toString('base64'), c.pbkdf2Sync(process.argv[1], s, 600000, 32, 'sha256').toString('base64'))" "<new password>"
# and put the two values it prints into $PasswordSalt and $PasswordHash.
$PasswordSalt = 'fB3aC+DRLGjaFJj5iAbPHg=='
$PasswordHash = '24l5qTTZl0ZC6pT59PlelYYpbXOhmFEb9SJ2cG+mZXM='

function Test-Password([string]$password) {
  # Rfc2898DeriveBytes with a hash algorithm needs .NET Framework 4.7.2, part of Windows 10 1803 and later
  $kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($password, [Convert]::FromBase64String($PasswordSalt), 600000, [Security.Cryptography.HashAlgorithmName]::SHA256)
  try { return [Convert]::ToBase64String($kdf.GetBytes(32)) -ceq $PasswordHash } finally { $kdf.Dispose() }
}

function Confirm-Password {
  Step 'Enter the installation password'
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $secure = Read-Host '    Password' -AsSecureString
    if (Test-Password ([Net.NetworkCredential]::new('', $secure).Password)) { return }
    Warn 'Wrong password.'
  }
  throw 'The password was wrong 3 times.'
}

# ---------- the project ----------

function Get-SourceDir([string]$installDir) {
  # a downloaded project around this script installs that copy; run from the installed folder
  # (the "Update" shortcut), on its own or through irm | iex, it gets the latest from GitHub
  if ($PSScriptRoot) {
    $here = Split-Path $PSScriptRoot -Parent
    $installed = (Test-Path $installDir) -and ((Resolve-Path $here).Path -eq (Resolve-Path $installDir).Path)
    if ((Test-Path (Join-Path $here 'server.js')) -and -not $installed) { return $here }
  }
  $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
  if ($env:STREAM_STUDIO_ARCHIVE) { $url = $env:STREAM_STUDIO_ARCHIVE }
  Step 'Downloading Stream Studio'
  Info $url
  $tmp = New-TempDir
  $zip = Join-Path $tmp 'stream-studio.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  Expand-Zip $zip $tmp
  $dir = Get-ChildItem -Path $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'server.js') } | Select-Object -First 1
  if (-not $dir) { throw "The download does not contain Stream Studio: $url" }
  return $dir.FullName
}

function Get-Port([string]$root) {
  # data\port.txt changes the port; updates keep the data folder
  $port = 3000
  $portFile = Join-Path $root 'data\port.txt'
  if (Test-Path $portFile) {
    $digits = (Get-Content -Raw $portFile) -replace '\D', ''
    if ($digits) { $port = [int]$digits }
  }
  return $port
}

function Stop-StreamStudio([string]$root) {
  # an update replaces node_modules, which Windows cannot do while the server or its ffmpeg is running.
  # Only THIS install's processes: its server.js on the command line, or a program inside its folder
  # (runtime\node\node.exe, the ffmpeg npm installed). Another Stream Studio is left alone.
  $server = Join-Path $root 'server.js'
  $inside = $root.TrimEnd('\') + '\'
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'ffmpeg.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.CommandLine -and $_.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($inside, [StringComparison]::OrdinalIgnoreCase))
    })
  if ($procs.Count -eq 0) { return }
  Step 'Closing the running Stream Studio for the update'
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

function Copy-Project([string]$from, [string]$to) {
  # the code only: an earlier install keeps its data, uploads, runtime and node_modules
  & robocopy $from $to /E /XD node_modules data uploads runtime .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying Stream Studio to $to failed (robocopy error $LASTEXITCODE)." }
}

# ---------- Node.js ----------

function Get-Node([string]$root) {
  $portable = Join-Path $root 'runtime\node\node.exe'
  if ((Test-Path $portable) -and ((Get-NodeMajor $portable) -ge $MinNode)) { return $portable }
  $system = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($system -and ((Get-NodeMajor $system.Source) -ge $MinNode) -and (Test-Path (Join-Path (Split-Path $system.Source) 'npm.cmd'))) {
    return $system.Source
  }
  return Install-PortableNode $root
}

function Install-PortableNode([string]$root) {
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  # newest first; Windows PowerShell passes a JSON array on as ONE object, so enumerate it from a variable
  $releases = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
  $release = $releases | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
  if (-not $release) { throw "No Node.js LTS release found for Windows $arch." }
  $version = $release.version
  $name = "node-$version-win-$arch"
  Step "Downloading Node.js $version ($arch) for Stream Studio"
  $tmp = New-TempDir
  $zip = Join-Path $tmp "$name.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt").Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
  $pattern = '(?m)^([0-9a-f]{64})\s+' + [regex]::Escape("$name.zip") + '\s*$'
  if ($sums -match $pattern) { $expected = $Matches[1] } else { throw "No checksum published for $name.zip." }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
  if ($actual -ne $expected) { throw 'The Node.js download is damaged (checksum mismatch). Run the installer again.' }
  Info 'Checksum OK'
  Expand-Zip $zip $tmp
  $dest = Join-Path $root 'runtime\node'
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  Move-Item -Path (Join-Path $tmp $name) -Destination $dest
  Remove-Item -Recurse -Force $tmp
  $node = Join-Path $dest 'node.exe'
  if ((Get-NodeMajor $node) -lt $MinNode) { throw 'The downloaded Node.js does not run on this PC. Install Node.js LTS from https://nodejs.org and run the installer again.' }
  return $node
}

# ---------- shortcuts ----------

function New-Shortcut([string]$path, [string]$root, [string]$target, [string]$arguments, [int]$windowStyle, [string]$description) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $root $target
  $link.Arguments = $arguments
  $link.WorkingDirectory = $root
  $link.WindowStyle = $windowStyle # 1 normal, 7 minimized
  $link.Description = $description
  $icon = Join-Path $root 'setup\stream-studio.ico'
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.Save()
}

# ---------- install ----------

function Install-StreamStudio {
  Write-Host ''
  Write-Host '  Stream Studio setup' -ForegroundColor Cyan
  Write-Host "  Installs into $InstallDir"

  Confirm-Password
  $source = Get-SourceDir $InstallDir
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $root = (Resolve-Path $InstallDir).Path
  $port = Get-Port $root
  Stop-StreamStudio $root
  if ((Resolve-Path $source).Path -ne $root) {
    Step "Copying Stream Studio to $root"
    Copy-Project $source $root
  }
  # files from a downloaded ZIP carry the "from the internet" mark that makes Windows ask before running them
  Get-ChildItem -Path $root -Include '*.bat', '*.ps1', '*.cmd' -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\node_modules\*' } | Unblock-File -ErrorAction SilentlyContinue

  $node = Get-Node $root
  Info "Node.js $(& $node --version) at $node"

  Step 'Installing the npm packages (Express, Socket.IO and ffmpeg for the CCTV cameras)'
  $nodeDir = Split-Path $node
  $env:Path = "$nodeDir;$env:Path" # npm and the ffmpeg download script need this node
  Push-Location $root
  try {
    & (Join-Path $nodeDir 'npm.cmd') ci --no-audit --no-fund --no-update-notifier
    if ($LASTEXITCODE -ne 0) { throw "npm could not install the packages (error $LASTEXITCODE). Check the internet connection and run the installer again." }
    $ffmpeg = & $node -e "const c = require('./cctv.js'); const v = c.ffmpegVersion(c.findFfmpeg()); process.stdout.write(v ? v.text : '')"
  } finally {
    Pop-Location
  }
  if ($ffmpeg) {
    Info "ffmpeg $ffmpeg is ready for the CCTV cameras"
  } else {
    Warn 'ffmpeg (needed only for CCTV cameras) could not be installed with the npm packages.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Step 'Installing ffmpeg with winget'
      & winget install --id Gyan.FFmpeg --exact --accept-source-agreements --accept-package-agreements
      Info 'If the CCTV test still says ffmpeg is missing, sign out of Windows and in again.'
    } else {
      Warn 'Install ffmpeg from https://www.gyan.dev/ffmpeg/builds/ and add its bin folder to PATH.'
    }
  }

  Step 'Adding Stream Studio to the desktop and the Start menu'
  $about = 'Stream Studio: camera live screen'
  $programs = [Environment]::GetFolderPath('Programs')
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Stream Studio.lnk') $root 'Start-StreamStudio.bat' '' 1 $about
  New-Shortcut (Join-Path $programs 'Stream Studio.lnk') $root 'Start-StreamStudio.bat' '' 1 $about
  New-Shortcut (Join-Path $programs 'Stream Studio - Update.lnk') $root 'Install-Windows.bat' "-InstallDir `"$root`"" 1 'Download the latest Stream Studio and keep your layout, cameras and uploads'

  $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Stream Studio.lnk'
  $auto = $AutoStart.IsPresent
  if (-not $AutoStart -and -not $NoAutoStart) {
    $default = 'n'
    $hint = '[y/N]'
    if (Test-Path $startup) { $default = 'y'; $hint = '[Y/n]' }
    $auto = (Ask "Start Stream Studio automatically when you log in to Windows? $hint" $default) -match '^[yY]'
  }
  if ($auto) {
    New-Shortcut $startup $root 'Start-StreamStudio.bat' '/nobrowser' 7 $about
    Info 'Stream Studio will start (minimized, without the browser) when you log in.'
  } elseif (Test-Path $startup) {
    Remove-Item $startup
    Info 'Stream Studio no longer starts at log-in.'
  }

  Step 'Stream Studio is installed'
  Info "Folder : $root"
  Info 'Start  : double-click "Stream Studio" on the desktop or in the Start menu'
  Info "Admin  : http://localhost:$port/admin/"
  Info "Output : http://localhost:$port/output/"
  Info 'The first time it starts, Windows Firewall may ask about Node.js: choose "Allow" so that'
  Info 'TVs and other computers on your network can open the output.'

  if (-not $NoStart) {
    if ((Ask 'Start Stream Studio now? [Y/n]' 'y') -match '^[yY]') {
      Start-Process -FilePath (Join-Path $root 'Start-StreamStudio.bat') -WorkingDirectory $root
    }
  }
}

try {
  Install-StreamStudio
} catch {
  Write-Host ''
  Write-Host "  Installation failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Fix the problem above and run the installer again; it continues where it stopped.' -ForegroundColor Red
}
