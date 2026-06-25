# 双薪写真画廊 — 当前上下文快照

**时间**: 2026-06-25
**项目**: https://1289107388.github.io/shungxin.github.io/
**Supabase 项目 ref**: qlhfyawbyedhqokivezn

---

## 已解决(已部署并验证)

### 1. Edge Functions CORS 预检 204 修复 ✅
**Bug**: `createCorsResponse({}, 204)` 抛出 `TypeError: Response with null body status cannot have body`
**修复**: `new Response(null, { status: 204, headers: CORS_HEADERS })`
**部署**: 4 个函数(like-toggle / view-count / comment-api / storage-monitor)全部在 Supabase Dashboard 部署成功,已用 `Invoke-WebRequest OPTIONS` 验证返回 204 + CORS 头。
**Commit**: `510ae44`(本地仓库)

### 2. 前端 image_id 类型修复 ✅
**Bug**: `threadKey.replace('image-', '')` 返回字符串 `"1"`,后端校验 `typeof image_id !== 'number'` → 400
**修复**: `parseInt(threadKey.replace('image-', ''), 10)`
**部署**: index.html,commit `3124ded`(本地仓库)

### 3. lightbox 评论数同步修复 ✅
**Commit**: `9610b32` (本地仓库)
**改动**:
- `window.commentCountsData` + `window.currentLightboxImageId` 跨 IIFE 共享状态
- `updateLightboxCommentCount` / `refreshLightboxCommentCount` 调用 `/functions/v1/comment-api/list` 用 `pagination.total` 作为真实数
- `openLightbox()` 和 `navigateLightbox()` 触发刷新,工具栏"Comment N"实时更新
- `loadCommentsFor` 改用 `pagination.total` 而不是 `data.data.length`
- `updateBadge()` 同步写 cache + lightbox + 卡片角标
- 模板里写死的 `'0'` 改成 `'…'`

---

## 当前唯一未完成的问题

### 4. comment-api 仍然返回 500 ⚠️ **未部署**
**测试结果**:
- `image_id: "1"`(字符串)→ 后端 400 `image_id 无效`
- `image_id: 1`(数字)→ 后端 500 `创建评论失败`

**根本原因**: 后端 `handleCreateComment` 写入 `source: 'website'`,但 `comments` 表的 `source` 列有 CHECK 约束只接受 `('local', 'giscus')` 之类(已用 REST API 测过 `source='local'` 成功,`source='website'` 报 23514 约束违反)。

**已验证**:
- `POST /rest/v1/comments body={image_id:1, source:'local', ...}` → 201 OK
- `POST /rest/v1/comments body={image_id:1, source:'website', ...}` → 400 check constraint

**本地代码修复**:
- `c:\Users\15051\Desktop\html\supabase\functions\comment-api\index.ts` 第 137 行
- 改: `source: 'website'` → `source: 'local'`
- git 状态: `M supabase/functions/comment-api/index.ts`(已暂存,未 commit)

**Dashboard 部署状态**: 仍然跑着老代码 `source: 'website'`,需要重新部署。

---

## 部署方法(Supabase Dashboard)

1. 打开 https://supabase.com/dashboard/project/qlhfyawbyedhqokivezn/functions/comment-api/code
2. 找第 137 行(在 `handleCreateComment` 里)
3. 改: `source: 'website'` → `source: 'local'`
4. 点 "Deploy updates" → 二次确认
5. 验证: `POST /functions/v1/comment-api/create body={image_id:1, content:"测试", github_username:"user"}` 应该返回 200

**或者 CLI 部署**(需要先 `supabase login`):
```bash
cd c:\Users\15051\Desktop\html
npx supabase functions deploy comment-api --project-ref qlhfyawbyedhqokivezn
```

---

## Git 状态

```
9610b32 Fix: lightbox comment count stays 0 and out of sync          (HEAD)
3124ded Fix: cast imageId to number in showCommentsFor, preventing HTTP 400 on comment submit
510ae44 Fix: Edge Functions CORS preflight 204 No Content bug
bb74201 Debug: Add console logs and show real error message in toast
a2baefb Fix: Remove Google Fonts and dicebear ...

未提交: M supabase/functions/comment-api/index.ts  (source: website → local)
未推送: 510ae44, 3124ded, 9610b32, plus 当前 M 修改
```

GitHub push 在 2026-06-24 之前是连得通的,2026-06-25 时报 `Failed to connect to github.com port 443` — 可能是 VPN 没开。

---

## 关键文件路径

- 前端: `c:\Users\15051\Desktop\html\index.html`
- Edge Functions: `c:\Users\15051\Desktop\html\supabase\functions\{like-toggle,view-count,comment-api,storage-monitor}\index.ts`
- 诊断/部署辅助: `c:\Users\15051\Desktop\html\诊断报告.md`, `Supabase部署指南.md`, `deploy-edge-functions.cmd`
- 工作目录: `c:\Users\15051\.trae-cn\work\6a3b3d4c4dbdc53baf0d660d`

---

## Supabase 项目记忆

- URL: `https://qlhfyawbyedhqokivezn.supabase.co`
- Anon Key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsaGZ5YXdieWVkaHFva2l2ZXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODUyNTUsImV4cCI6MjA5Nzg2MTI1NX0.uJF2_JLDl2cDruSYeHAg4r6ZxZRbsgqhW_xfZ3YZ_Kk`
- 评论表: `comments`(已存在,source CHECK 约束)
- 点赞表: `image_likes`, `likes`, `like_logs`
- 浏览量表: `image_views`
- 5 个 Edge Functions: `like-toggle`, `view-count`, `comment-api`, `storage-monitor`, `rapid-workerview-countview-count`

---

## 用户的明确要求

1. ✅ **CORS 修复** — 已完成
2. ✅ **前端 image_id 修复** — 已完成
3. ✅ **lightbox 评论数同步** — 已完成(commit 9610b32)
4. ⚠️ **comment-api source 修复** — 本地已改,待 Dashboard 部署
5. ⚠️ **GitHub push 同步** — 待网络恢复后 `git push origin master`
