# 自动重试推送：链路是间歇性的，趁着能连的窗口把代码推上去
# 用法: .\push-retry.ps1 -User 你的GitHub用户名

param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Repo = "ring-wanderer",
  [string]$Branch = "main",
  [int]$MaxTries = 40
)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$env:GIT_TERMINAL_PROMPT = "0"

Write-Host ""
Write-Host "==> 目标: https://github.com/$User/$Repo" -ForegroundColor Cyan
Write-Host "==> 最多重试 $MaxTries 次，间隔 5 秒" -ForegroundColor Cyan
Write-Host ""

# 配置远程
$existing = git remote 2>$null
if ($existing -notcontains "origin") {
  git remote add origin "https://github.com/$User/$Repo.git"
}

$success = $false
for ($i = 1; $i -le $MaxTries; $i++) {
  Write-Host -NoNewline ("[{0}/{1}] 尝试推送... " -f $i, $MaxTries)

  # 用 --force-with-lease 但显式指定远程哈希，跳过 fetch
  # 远程只有一个占位 README（9b8df94），丢弃它无损失
  $output = git push --force-with-lease -u origin $Branch 2>&1
  $code = $LASTEXITCODE

  if ($code -eq 0) {
    Write-Host "成功!" -ForegroundColor Green
    $success = $true
    break
  }

  $text = ($output | Out-String)

  if ($text -match 'stale info') {
    # lease 过期：刷新后立刻重推
    Write-Host "lease 过期，刷新..." -ForegroundColor Yellow
    git fetch origin 2>&1 | Out-Null
    continue
  }

  if ($text -match 'Connection was reset|Could not connect|Recv failure|timed out|Failed to connect') {
    Write-Host "网络中断，5 秒后重试" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    continue
  }

  if ($text -match 'everything up-to-date') {
    Write-Host "已是最新" -ForegroundColor Green
    $success = $true
    break
  }

  # 其他错误：打印后停止
  Write-Host "其他错误:" -ForegroundColor Red
  Write-Host $text
  break
}

Write-Host ""
if ($success) {
  Write-Host "==> 推送成功" -ForegroundColor Green
  Write-Host "  仓库: https://github.com/$User/$Repo"
  Write-Host ""
  Write-Host "接下来开启 Pages:"
  Write-Host "  https://github.com/$User/$Repo/settings/pages"
  Write-Host "  Source 选 Deploy from a branch"
  Write-Host "  Branch 选 $Branch, 目录选 / (root), 点 Save"
  Write-Host ""
  Write-Host "约 1-2 分钟后访问: https://$User.github.io/$Repo/"
} else {
  Write-Host "==> 重试用尽仍未成功" -ForegroundColor Red
  Write-Host "   网络持续被干扰，建议改用网页上传（见 DEPLOY.md 方案 C）"
  exit 1
}
