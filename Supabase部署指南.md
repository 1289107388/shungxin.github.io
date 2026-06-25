# 🔧 Supabase Edge Functions 重新部署指南

## 问题确认

✅ **GET 请求**：返回 200 + 正确数据
❌ **OPTIONS 预检**：返回 500 Internal Server Error (`EDGE_FUNCTION_ERROR`)

**根本原因**：你的 GitHub 仓库 (`master` 分支) 中 Edge Function 代码已经包含正确的 OPTIONS 处理（`if (req.method === 'OPTIONS') return createCorsResponse({}, 204)`），但**实际部署到 Supabase 的版本是旧代码**（没有 OPTIONS 处理）。

由于你的项目**没有 GitHub Actions 自动部署 Edge Function**，所以代码改动后必须**手动部署**。

## 修复步骤（最简单）

### 步骤 1：获取 Supabase Access Token

1. 打开 https://supabase.com/dashboard/account/tokens
2. 点击 "Generate new token"
3. 命名：`deploy-edge-functions`
4. 复制 token（格式类似 `sbp_xxxxxxxxxxxxxxxxxxxx`）

### 步骤 2：运行部署脚本

我已经在桌面创建了部署脚本：`deploy-edge-functions.cmd`

打开 PowerShell，进入桌面：
```powershell
cd C:\Users\15051\Desktop\html
```

设置环境变量（替换为你的实际 token）：
```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxxxxxxxxxxxxxx"
$env:SUPABASE_PROJECT_REF = "qlhfyawbyedhqokivezn"
```

运行部署：
```powershell
npx supabase functions deploy like-toggle --project-ref qlhfyawbyedhqokivezn --no-verify-jwt
npx supabase functions deploy view-count --project-ref qlhfyawbyedhqokivezn --no-verify-jwt
npx supabase functions deploy comment-api --project-ref qlhfyawbyedhqokivezn --no-verify-jwt
npx supabase functions deploy storage-monitor --project-ref qlhfyawbyedhqokivezn --no-verify-jwt
```

### 步骤 3：验证修复

部署完成后，再次访问：
- https://1289107388.github.io/shungxin.github.io/

点赞和评论应该立即同步到数据库。

## 验证脚本

我可以用以下命令测试 OPTIONS 是否成功：

```powershell
$req = [System.Net.HttpWebRequest]::Create("https://qlhfyawbyedhqokivezn.supabase.co/functions/v1/like-toggle/counts")
$req.Method = "OPTIONS"
$req.Headers.Add("Origin", "https://1289107388.github.io")
$req.Headers.Add("Access-Control-Request-Method", "GET")
$req.Headers.Add("Access-Control-Request-Headers", "apikey,authorization")
$req.Timeout = 15000
try { $req.GetResponse() | Out-Null; Write-Host "OK" } catch { Write-Host "Status: $($_.Exception.Response.StatusCode)" }
```

应该看到 `Status: 204`（不再是 500）。

## 替代方案：用 Supabase Dashboard 手动操作

如果你不想用 CLI，可以在 Dashboard 手动部署：

1. 打开 https://supabase.com/dashboard/project/qlhfyawbyedhqokivezn/functions
2. 点击 `like-toggle` 函数
3. 在代码编辑器中，确认包含以下代码（在最顶部）：

```typescript
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return createCorsResponse({}, 204);
  }
  // ... 其余代码
});
```

4. 如果代码**已经包含**这段但仍然返回 500 → 这是 Supabase 服务端问题，需要联系 Supabase 支持
5. 如果代码**不包含**这段 → 复制 GitHub 仓库里的 `supabase/functions/like-toggle/index.ts` 完整代码粘贴进去
6. 点击 "Deploy"

对 `view-count`、`comment-api`、`storage-monitor` 重复以上操作。

## 已完成的前端修复

无论你是否执行后端部署，我之前已经修复了**所有前端代码问题**：

- ✅ 移除对外部 Supabase SDK 的依赖
- ✅ 修复 `comment-api` 的 fetch 调用格式
- ✅ 移除 Google Fonts 和 dicebear 外部依赖
- ✅ 添加详细错误日志

所以**只要 Edge Function 部署到最新代码，前端就完全可用**。
