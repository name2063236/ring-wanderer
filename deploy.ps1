# 一键发布到 GitHub Pages
# 用法：在 PowerShell 里先 setup，再运行本脚本
#   .\deploy.ps1 -User 你的GitHub用户名
#
# 前置：已在 GitHub 网页端手动创建空仓库（不要勾选 README / .gitignore / license）
# 也可以用 -Repo 指定仓库名，默认 ring-wanderer

param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Repo = "ring-wanderer",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n==> 目标仓库：https://github.com/$User/$Repo" -ForegroundColor Cyan

# 1. 配置远程
$existing = git remote 2>$null
if ($existing -contains "origin") {
  git remote set-url origin "https://github.com/$User/$Repo.git"
  Write-Host "已更新 origin"
} else {
  git remote add origin "https://github.com/$User/$Repo.git"
  Write-Host "已添加 origin"
}

# 2. 推送
Write-Host "`n==> 推送（会要求输入 GitHub 用户名 + Personal Access Token）" -ForegroundColor Yellow
Write-Host "    注意：密码栏要填 Token，不是账号密码" -ForegroundColor Yellow
git push -u origin $Branch

if ($LASTEXITCODE -ne 0) {
  Write-Host "`n推送失败。常见原因：" -ForegroundColor Red
  Write-Host "  - 仓库还没在网页端创建"
  Write-Host "  - Token 没有 repo 权限"
  Write-Host "  - 远程已有内容（先 git pull --rebase origin $Branch）"
  exit 1
}

# 3. 开启 GitHub Pages（需要 gh CLI；没有就手动设置）
Write-Host "`n==> 配置 GitHub Pages" -ForegroundColor Cyan
$ghExists = Get-Command gh -ErrorAction SilentlyContinue
if ($ghExists) {
  gh api -X POST "repos/$User/$Repo/pages" -f "source[branch]=$Branch" -f "source[path]=/" 2>$null
  if ($LASTEXITCODE -ne 0) {
    gh api -X PUT "repos/$User/$Repo/pages" -f "source[branch]=$Branch" -f "source[path]=/" 2>$null
  }
  Write-Host "已通过 gh 配置 Pages"
} else {
  Write-Host "未检测到 gh CLI，请手动开启："
  Write-Host "  仓库页 → Settings → Pages → Source 选 'Deploy from a branch'"
  Write-Host "  Branch 选 '$Branch'，目录选 '/ (root)'，保存"
}

Write-Host "`n==> 完成" -ForegroundColor Green
Write-Host "  仓库： https://github.com/$User/$Repo"
Write-Host "  游戏： https://$User.github.io/$Repo/"
Write-Host "`nPages 首次部署约需 1-2 分钟。"
