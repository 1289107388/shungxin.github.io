# 管理员系统部署指南

## 完成情况

| 文件 | 状态 | 说明 |
|------|------|------|
| `sql/create_admin_system.sql` | ✅ 已生成 | 数据库表初始化 + 默认数据 + 升级 SQL |
| `supabase/functions/admin-api/index.ts` | ✅ 已生成 | Edge Function 完整代码 (约 700 行) |
| `admin.html` | ✅ 已生成 | 独立管理后台 UI (仪表板 + 4 个管理子页) |

## 你需要做的部署步骤

### 步骤 1 · 跑 SQL 初始化 (2 分钟)

1. 打开 Supabase Dashboard → SQL Editor
2. 把 `c:\Users\15051\Desktop\html\sql\create_admin_system.sql` 全部内容贴进去
3. 点击 "Run" 执行

> **报错怎么办**: 如果报 `policy already exists`,先跑下面的清理 SQL 再重新执行主脚本:
> ```sql
> DROP POLICY IF EXISTS "访客可读取可见图片" ON public.gallery_images;
> DROP POLICY IF EXISTS "服务角色可管理图片" ON public.gallery_images;
> DROP POLICY IF EXISTS "服务角色可管理审计日志" ON public.admin_audit_logs;
> ```

### 步骤 2 · 指定管理员账号 (30 秒)

在 SQL Editor 再跑一行(把你的用户名替换进去):

```sql
UPDATE public.users SET role = 'admin' WHERE username = '你的管理员账号';
```

> ⚠️ **必须**: 注册过至少一个普通账号,SQL 才会生效。还没注册账号先在首页注册一个。

### 步骤 3 · 部署 admin-api Edge Function (3-5 分钟)

> ⚠️ **警告**: 上次部署 auth-api 时被 Dashboard 重置成空模板,**操作前先把代码复制到本地备份**。

1. Dashboard → Edge Functions → "Deploy a new function"
2. 名字填 `admin-api`
3. 把 `c:\Users\15051\Desktop\html\supabase\functions\admin-api\index.ts` 完整内容贴进去
4. Deploy

> 或者用 Supabase CLI:
> ```bash
> npx supabase functions deploy admin-api --project-ref qlhfyawbyedhqokivezn
> ```

### 步骤 4 · 访问管理后台

打开 `https://你的域名/admin.html` (或本地 `file:///C:/Users/15051/Desktop/html/admin.html`)

用步骤 2 中指定的管理员账号登录即可。

## 包含的管理功能

### 仪表板
- 总用户数 / 活跃用户 / 7 天新增
- 总评论数 / 待审核 / 今日新增
- 总图片数 / 可见图片数
- 总点赞数 / 今日点赞
- 总浏览量 / 今日浏览
- 近 7 天用户注册趋势图 (纯 CSS 柱状图,无依赖)

### 用户管理
- 列表(分页/搜索/筛选角色/筛选状态)
- 启用/禁用用户(防自禁用)
- 升级/降级管理员(防自降级)
- 删除用户(级联删除 sessions)

### 图片管理
- 卡片网格展示 15 张图片
- 切换可见性(显示/隐藏)
- 切换"新作品"标签
- 编辑标题/分类/排序/描述
- 显示每张图的点赞数和浏览数

### 评论管理
- 列表(分页/搜索/筛选状态)
- 删除任意评论

### 审计日志
- 所有管理操作的完整记录
- 操作者 / 操作类型 / 目标 / 详情 / IP
- 按操作类型筛选

## API 接口列表(供二次开发)

所有接口 base: `https://qlhfyawbyedhqokivezn.supabase.co/functions/v1/admin-api`

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查(免鉴权) |
| `/dashboard` | GET | 仪表板统计 |
| `/users` | GET | 列出用户(支持 page/pageSize/search/role/status) |
| `/users/:id` | GET | 单个用户详情 |
| `/users/:id/status` | PUT | 启用/禁用用户 |
| `/users/:id/role` | PUT | 升级/降级 |
| `/users/:id` | DELETE | 删除用户 |
| `/comments` | GET | 列出评论 |
| `/comments/:id` | DELETE | 删除评论 |
| `/images` | GET | 列出图片(含点赞/浏览) |
| `/images/:id/visibility` | PUT | 切换可见性 |
| `/images/:id/meta` | PUT | 更新元数据 |
| `/audit-logs` | GET | 查询审计日志 |

**鉴权**: 所有接口需 `Authorization: Bearer <token>` 头。Token 从 `auth-api/login` 获取,需 `role='admin'`。

## 常见问题

**Q1: 登录后立刻返回 401?**
A: 没跑步骤 1 的 SQL。检查 SQL 是否成功执行(到 Table Editor 看是否多了 `gallery_images` 和 `admin_audit_logs` 表)。

**Q2: 登录后返回 "该账号不是管理员"?**
A: 步骤 2 没执行,或 username 拼错了。再跑一次:
```sql
SELECT id, username, role FROM public.users;
-- 确认你想当管理员的账号
UPDATE public.users SET role = 'admin' WHERE id = <上面查到的 id>;
```

**Q3: 部署后接口 401 "Invalid credentials"?**
A: 上次发生过 Dashboard 部署函数时代码被重置成空模板的情况。**先到 Code 页面看 index.ts 是不是 10 行空模板**。如果是,在 Code 页面重新 paste 完整代码并 Deploy。

**Q4: 前端图片列表显示空白?**
A: SQL 步骤 1 的 INSERT 没成功。看下 `SELECT * FROM gallery_images` 有没有 15 行。

**Q5: 想让前台网站也用 gallery_images 表替代硬编码?**
A: 需要修改 `index.html` 1547-1565 行的 `IMAGES` 数组,改为从 `gallery_images` 拉数据。后续可以加 `index.html` 自动隐藏 `is_visible=false` 的图片,以及 `is_new=true` 显示新作品标签。**这次没改,避免影响现有功能。**
