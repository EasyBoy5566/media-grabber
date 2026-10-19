# 發佈新版本：更新 manifest 版本號 → commit → 打標籤 → 推送。
# GitHub Actions 收到標籤後會自動建立 Release，使用者的擴充功能就會提示更新。
#
# 用法（在專案根目錄）：
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 1.5.0

param(
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本號格式要像 1.5.0" }

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'media-grabber\manifest.json'

if (git -C $root status --porcelain) {
  Write-Host '工作目錄有尚未 commit 的變更，請先 commit 或還原。' -ForegroundColor Yellow
  exit 1
}

# 只替換 "version" 那一行，保留原本的格式
$text = [IO.File]::ReadAllText($manifestPath)
$text = [regex]::Replace($text, '"version":\s*"[^"]*"', "`"version`": `"$Version`"", 1)
[IO.File]::WriteAllText($manifestPath, $text, (New-Object Text.UTF8Encoding $false))

git -C $root add media-grabber/manifest.json
git -C $root commit -m "Release v$Version"
git -C $root tag "v$Version"
git -C $root push origin HEAD "v$Version"

Write-Host "已推送 v$Version，GitHub Actions 幾分鐘內會建立 Release。" -ForegroundColor Green
