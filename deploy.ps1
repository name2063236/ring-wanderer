# ============================================================
# 一键发布到 GitHub Pages
#
# 用法:
#   cd D:\DSH-Workspace\test4
#   .\deploy.ps1 -User 你的GitHub用户名
#
# 前置: 已在 GitHub 网页端创建空仓库 (不要勾 README/.gitignore/license)
# 可选参数: -Repo 仓库名 (默认 ring-wanderer)
# ============================================================

param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Repo = "ring-wanderer",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "==> 目标仓库: https://github.com/$User/$Repo" -ForegroundColor Cyan

# ---------- 1. 配置远程 ----------
$existing = git remote 2>$null
if ($existing -contains "origin") {
  git remote set-url origin "https://github.com/$User/$Repo.git"
  Write-Host "已更新 origin"
} else {
  git remote add origin "https://github.com/$User/$Repo.git"
  Write-Host "已添加 origin"
}

# ---------- 2. 推送 ----------
Write-Host ""
Write-Host "==> 推送中 (会弹出 GitHub 认证窗口)" -ForegroundColor Yellow
Write-Host "    建议选 Sign in with your browser，最省事" -ForegroundColor Yellow
Write-Host ""
git push -u origin $Branch

if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "推送失败，常见原因:" -ForegroundColor Red
  Write-Host "  - 仓库还没在网页端创建: https://github.com/new"
  Write-Host "  - 用户名或仓库名拼写错误"
  Write-Host "  - 认证被取消，重新运行本脚本即可"
  exit 1
}

# ---------- 3. 开启 GitHub Pages ----------
Write-Host ""
Write-Host "==> 配置 GitHub Pages" -ForegroundColor Cyan
$ghExists = Get-Command gh -ErrorAction SilentlyContinue

if ($ghExists) {
  gh api -X POST "repos/$User/$Repo/pages" -f "source[branch]=$Branch" -f "source[path]=/" 2>$null
  if ($LASTEXITCODE -ne 0) {
    gh api -X PUT "repos/$User/$Repo/pages" -f "source[branch]=$Branch" -f "source[path]=/" 2>$null
  }
  if ($LASTEXITCODE -eq 0) {
    Write-Host "已通过 gh 开启 Pages"
  } else {
    Write-Host "gh 配置失败，请手动开启 (步骤见下)"
  }
} else {
  Write-Host "未检测到 gh CLI，请手动开启 Pages:"
  Write-Host "  1. 打开 https://github.com/$User/$Repo/settings/pages"
  Write-Host "  2. Source 选 Deploy from a branch"
  Write-Host "  3. Branch 选 $Branch, 目录选 / (root)"
  Write-Host "  4. 点 Save"
}

Write-Host ""
Write-Host "==> 完成" -ForegroundColor Green
Write-Host "  仓库: https://github.com/$User/$Repo"
Write-Host "  游戏: https://$User.github.io/$Repo/"
Write-Host ""
Write-Host "Pages 首次部署约需 1-2 分钟。"
