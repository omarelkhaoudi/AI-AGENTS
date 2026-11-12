@echo off
rem H-KIDS Cockpit, in one double-click (the desktop shortcut runs this file).
rem It takes the latest version from GitHub, installs what it needs, starts
rem the cockpit and opens it in the browser. Closing this window stops it.
chcp 65001 >nul
title H-KIDS Cockpit
cd /d "%~dp0.."

echo.
echo  H-KIDS Cockpit
echo  ==============
echo.
echo  1. Recherche d'une mise a jour...
rem npm may have rewritten the lock file: it would stop the update.
git checkout -- package-lock.json 2>nul
git pull --ff-only
if errorlevel 1 (
  echo     Pas de mise a jour possible pour l'instant : le cockpit demarre tel quel.
)

echo  2. Verification des composants...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo     L'installation a echoue : le cockpit essaie de demarrer quand meme.
)

echo  3. Demarrage. Le navigateur s'ouvre tout seul dans quelques secondes.
echo     Laissez cette fenetre ouverte : la fermer arrete le cockpit.
echo.
start "" /b node scripts\open-cockpit.mjs
call npm start

echo.
echo  Le cockpit s'est arrete. Appuyez sur une touche pour fermer cette fenetre.
pause >nul
