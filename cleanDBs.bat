@echo off
set TELEWORKRDIR=%~dp0

rmdir /s /q %TELEWORKRDIR%\backend\apps\teleworkr\cms
mkdir %TELEWORKRDIR%\backend\apps\teleworkr\cms
rmdir /s /q %TELEWORKRDIR%\backend\apps\teleworkr\db\teleworkr_db
mkdir %TELEWORKRDIR%\backend\apps\teleworkr\db\teleworkr_db
del /q %TELEWORKRDIR%\backend\apps\teleworkr\db\sqlite\teleworkr.db*

echo Done.
