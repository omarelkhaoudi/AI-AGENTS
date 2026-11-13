# Copies the nightly backups of the hosted cockpit onto this PC, so they survive
# the loss of the server. Only the backups this PC does not have yet are
# downloaded; the most recent 90 are kept here (the server keeps 30).
#
# Install once, from PowerShell, in the project folder. It copies once at once,
# then every day at noon, or as soon as the PC is switched on if it was off:
#
#   powershell -ExecutionPolicy Bypass -File scripts\copier-sauvegardes.ps1 -Installer
#
# The SSH key is the server's own (see docs/DEPLOIEMENT-ORACLE.md). Each run
# writes one line to copie.log in the destination folder.
param(
  [string]$Serveur = "ubuntu@hkids-cockpit.duckdns.org",
  [string]$Cle = "$env:USERPROFILE\.ssh\hkids-oracle.key",
  [string]$Destination = "$env:USERPROFILE\Documents\Sauvegardes H-KIDS",
  [int]$Garder = 90,
  [switch]$Installer
)
$ErrorActionPreference = "Stop"
$nomTache = "H-KIDS - copie des sauvegardes"
$dossierServeur = "/opt/hkids/deploy/backups"
# accept-new: the first run records the server's key, later runs refuse a
# server whose key changed.
$optionsSsh = @("-i", $Cle, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new")

if ($Installer) {
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($PSBoundParameters.ContainsKey("Serveur")) { $arguments += " -Serveur `"$Serveur`"" }
  if ($PSBoundParameters.ContainsKey("Cle")) { $arguments += " -Cle `"$Cle`"" }
  if ($PSBoundParameters.ContainsKey("Destination")) { $arguments += " -Destination `"$Destination`"" }
  if ($PSBoundParameters.ContainsKey("Garder")) { $arguments += " -Garder $Garder" }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
  $declencheur = New-ScheduledTaskTrigger -Daily -At "12:00"
  $reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName $nomTache -Action $action -Trigger $declencheur -Settings $reglages -Description "Copie les sauvegardes du cockpit H-KIDS du serveur vers $Destination." -Force | Out-Null
  Write-Host "Tache planifiee '$nomTache' installee : chaque jour a midi, ou des que le PC est allume."
  Write-Host "Premiere copie..."
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$journal = Join-Path $Destination "copie.log"
function Write-Journal([string]$message) {
  Add-Content -Path $journal -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $message"
}

try {
  $listeServeur = & ssh @optionsSsh $Serveur "ls -1 $dossierServeur"
  if ($LASTEXITCODE -ne 0) { throw "le serveur n'a pas repondu (code $LASTEXITCODE)" }
  # Only finished backups: a run in progress writes into a hidden folder.
  $surServeur = @($listeServeur | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}_\d{4}$' })
  $nouvelles = @($surServeur | Where-Object { -not (Test-Path (Join-Path $Destination $_)) })

  foreach ($sauvegarde in $nouvelles) {
    # Downloaded under a hidden name and renamed once complete, so a copy cut
    # short is never taken for a good one; the next run starts it again.
    $partielle = Join-Path $Destination ".$sauvegarde"
    if (Test-Path $partielle) { Remove-Item -Recurse -Force $partielle }
    & scp @optionsSsh -r -q "${Serveur}:$dossierServeur/$sauvegarde" $partielle
    if ($LASTEXITCODE -ne 0) { throw "la copie de $sauvegarde a echoue (code $LASTEXITCODE)" }
    Rename-Item -Path $partielle -NewName $sauvegarde
  }

  $ici = @(Get-ChildItem -Directory -Path $Destination | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } | Sort-Object Name)
  if ($ici.Count -gt $Garder) {
    $ici | Select-Object -First ($ici.Count - $Garder) | Remove-Item -Recurse -Force
  }
  $message = "OK : $($nouvelles.Count) nouvelle(s), $([Math]::Min($ici.Count, $Garder)) sauvegarde(s) sur ce PC"
  Write-Journal $message
  Write-Host $message
} catch {
  Write-Journal "ERREUR : $_"
  throw
}
