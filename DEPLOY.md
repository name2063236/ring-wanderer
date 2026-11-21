# 发布到 GitHub Pages

目标是让别人点开一个链接就能玩，不需要下载、不需要构建、不需要服务器。

本作是**纯静态站点**：所有资源都是相对路径，没有后端、没有构建步骤，
`index.html` 放在仓库根目录就能直接被 Pages 托管。

## 前置条件

1. 一个 GitHub 账号
2. 本机已装 git（已确认：`git version 2.52.0`）
3. **一个 Personal Access Token**（不是账号密码）——这是 GitHub 现在的要求

### 怎么拿到 Token

1. 打开 <https://github.com/settings/tokens>
2. **Generate new token (classic)**
3. Note 随便填，比如 `ring-wanderer-deploy`
4. Expiration 选 30 天即可（发布完就能删）
5. 勾选 **`repo`** 这一整项（必须有，否则推送会被拒）
6. 生成后**立刻复制**，页面关掉就再也看不到了

## 步骤

### 1. 在 GitHub 网页端创建空仓库

打开 <https://github.com/new>：

- **Repository name**：`ring-wanderer`（或你喜欢的名字）
- **不要**勾选 "Add a README file"
- **不要**勾选 .gitignore 或 license

> 必须留空，否则推送时会产生 unrelated histories 冲突。

### 2. 在本地推送

在项目目录里打开 PowerShell：

```powershell
cd D:\DSH-Workspace\test4
.\deploy.ps1 -User 你的GitHub用户名
```

脚本会让你输入用户名和 Token：

- Username：你的 GitHub 用户名
- Password：**粘贴 Token**（输入时不显示，粘贴后直接回车）

> 如果提示"无法加载文件，因为在此系统上禁止运行脚本"，先执行一次：
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

### 3. 开启 GitHub Pages

**如果装了 gh CLI**，脚本会自动配好。

**没装的话手动做**（30 秒）：

1. 打开 `https://github.com/你的用户名/ring-wanderer/settings/pages`
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`
4. 点 **Save**

### 4. 等待部署

首次部署约 1–2 分钟。之后访问：

```
https://你的用户名.github.io/ring-wanderer/
```

## 常见问题

**推送被拒：`Authentication failed`**
Token 没填对，或者没勾 `repo` 权限。重新生成一个。

**网站 404**
- Pages 还没部署完，等 1–2 分钟
- Source 没选对，检查 Branch 和目录
- 仓库是 private 的免费账号 —— Pages 需要公开仓库（或 Pro 账号）

**页面空白 / 控制台报错**
本作依赖 WebGL。如果浏览器/显卡不支持，页面会在左下角显示红色错误框。
另外指针锁定需要 HTTPS 或 localhost —— GitHub Pages 是 HTTPS，没问题。

**想更新游戏内容**
改完代码后：

```powershell
git add -A
git commit -m "更新说明"
git push
```

Pages 会自动重新部署。

## 不想用 Pages 的替代方案

| 方式 | 说明 |
| --- | --- |
| **itch.io** | 上传 zip（把 index.html 设为入口），免费，适合游戏展示 |
| **Cloudflare Pages** | 连 GitHub 仓库自动部署，免费且速度快 |
| **Netlify** | 拖拽文件夹即可上线，最简单 |

三种都支持纯静态站点，任选其一。
