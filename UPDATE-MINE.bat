@echo off
rem Update Strata while keeping my own changes (the Traditional Chinese UI and the three chat add-ons).
rem Plain UPDATE.bat pulls with --ff-only, which stops once this folder carries its own commits.
rem This one merges the newest Strata in instead, then does the same engine/package/settings update.
rem Order: save my work to my fork, fetch the newest Strata, merge it, save the merged result, update.
setlocal
title Strata - update (keeps my changes)
cd /d "%~dp0"
rem All of it in one block: cmd reads a .bat file while it runs it, and the merge can change this very file.
(
  set "UNSAVED="
  git diff --quiet
  if errorlevel 1 set "UNSAVED=1"
  git diff --cached --quiet
  if errorlevel 1 set "UNSAVED=1"
  if defined UNSAVED (
    echo.
    echo  You changed files here that are not saved as a commit yet. Save them first:
    echo    git add -A
    echo    git commit -m "my changes"
    echo  Then run this again. Nothing was touched.
    pause
    exit /b 1
  )
  echo  Saving your current work to your GitHub fork ...
  git push fork main
  if errorlevel 1 echo  (Your fork was not reachable. The update goes on; your work is safe in this folder.)
  echo  Getting the newest Strata ...
  git fetch origin
  if errorlevel 1 (
    echo  Could not reach GitHub. Check your internet connection, then run this again.
    pause
    exit /b 1
  )
  echo  Merging the newest Strata into your copy ...
  git merge --no-edit origin/main
  if errorlevel 1 (
    echo.
    echo  The new version and your changes touch the same lines, so git stopped before changing any file.
    echo  To put this folder back exactly as it was, run:
    echo    git merge --abort
    echo  Then ask for help with the merge.
    pause
    exit /b 1
  )
  echo  Saving the merged result to your GitHub fork ...
  git push fork main
  echo  Updating the engine, the Python packages, and each model's settings ...
  call "%~dp0START-HERE.bat" --update %*
  if not errorlevel 1 pause
  exit /b
)
