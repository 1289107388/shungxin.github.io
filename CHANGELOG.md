# 部署变更记录 (2026-06-24)

## 更新概述

本次更新完成了"双薪写真画廊"后端架构优化，包含三层架构拆分、接口限流防刷、RLS 权限配置和存储容量监控告警功能。

---

## 一、三层架构拆分 ✅

### 改动说明
将业务逻辑从前端直连数据库改为通过 Edge Functions API 访问，实现控制层、业务层、数据层分离。

### 新增 Edge Functions

| 函数名 | 端点 | 功能说明 |
|--------|------|----------|
| `like-toggle` | `/functions/v1/like-toggle` | 点赞功能（含限流验证） |
| `comment-api` | `/functions/v1/comment-api` | 评论 CRUD 操作 |
| `view-count` | `/functions/v1/view-count` | 浏览量统计 |
| `storage-monitor` | `/functions/v1/storage-monitor` | 存储容量监控 |

### 前端适配
- `index.html` 中的点赞功能改为调用 `supabaseClient.functions.invoke('like-toggle')`
- 不再允许前端直连数据库进行点赞操作

---

## 二、接口限流防刷 ✅

### 实现方案
在 `like-toggle` Edge Function 中集成内存式限流器：

```typescript
// 位置: supabase/functions/_shared/rateLimiter.ts
// 限制: 每个 IP 每分钟最多 10 次点赞请求
```

### 限流规则
- **窗口期**: 60 秒
- **最大请求数**: 10 次
- **超额响应**: HTTP 429 Too Many Requests

---

## 三、RLS 权限策略完善 ✅

### 新增表结构

#### `like_logs` 表
记录每次点赞/取消操作，用于审计和防刷分析。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| user_id | TEXT | 用户标识 |
| image_id | TEXT | 图片标识 |
| action | TEXT | 操作类型 (like/unlike) |
| ip_address | TEXT | IP 地址 |
| user_agent | TEXT | 浏览器标识 |
| created_at | TIMESTAMPTZ | 创建时间 |

#### `storage_monitor_logs` 表
存储容量监控历史记录。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| created_at | TIMESTAMPTZ | 创建时间 |
| usage_mb | NUMERIC | 使用量 (MB) |
| limit_mb | NUMERIC | 限制量 (MB) |
| usage_percent | NUMERIC(5,2) | 使用百分比 |
| alert_level | TEXT | 告警级别 (normal/warning/critical) |
| tables_snapshot | JSONB | 各表大小快照 |
| recommendations | JSONB | 优化建议 |

### RLS 策略配置

| 表名 | 策略名称 | 允许角色 | 操作 |
|------|----------|----------|------|
| image_likes | 访客可读取点赞计数 | anon, authenticated | SELECT |
| image_likes | 仅服务角色可修改点赞计数 | service_role | ALL |
| image_views | 访客可读取浏览量 | anon, authenticated | SELECT |
| image_views | 仅服务角色可修改浏览量 | service_role | ALL |
| likes | 用户只能操作自己的点赞 | authenticated | ALL |
| likes | 服务角色可管理点赞明细 | service_role | ALL |
| comments | 访客可读取已审核评论 | anon, authenticated | SELECT |
| comments | 认证用户可创建评论 | authenticated | INSERT |
| comments | 用户只能修改自己的评论 | authenticated | UPDATE |
| comments | 仅管理员可删除评论 | service_role | DELETE |
| like_logs | 仅服务角色可管理日志 | service_role | ALL |
| comment_sync_logs | 仅服务角色可管理同步日志 | service_role | ALL |
| storage_monitor_logs | 仅服务角色可管理监控日志 | service_role | ALL |

---

## 四、存储容量监控告警 ✅

### 告警阈值

| 级别 | 阈值 | 说明 |
|------|------|------|
| `normal` | < 450 MB | 存储空间正常 |
| `warning` | 450-479 MB | 存储空间即将不足，建议清理 |
| `critical` | ≥ 480 MB | 存储空间严重不足，需立即清理 |

### 新增数据库函数

| 函数名 | 功能说明 |
|--------|----------|
| `get_table_sizes()` | 查询各表大小和行数 |
| `get_database_size_mb()` | 查询数据库总大小 |
| `cleanup_expired_logs()` | 清理过期日志（默认保留90天） |
| `cleanup_rejected_comments()` | 清理已拒绝/垃圾评论 |
| `cleanup_expired_data()` | 综合清理函数 |
| `check_storage_alert()` | 检查存储告警状态 |

### API 响应格式

```json
{
  "success": true,
  "alert": false,
  "level": "normal",
  "usageMB": 10,
  "limitMB": 500,
  "usagePercent": 2.0
}
```

---

## 五、数据库触发器优化 ✅

### 自动计数触发器
- `likes` 表变化时自动更新 `image_likes.count`
- `comments` 表变化时自动更新 `profiles.comment_count`

### 自动日志触发器
- `likes` 表变化时自动记录到 `like_logs`
- `comments` 表变化时自动记录到 `comment_sync_logs`

---

## 六、索引优化 ✅

新增以下索引提升查询性能：

```sql
CREATE INDEX idx_likes_image_id ON likes(image_id);
CREATE INDEX idx_likes_user_id ON likes(user_id);
CREATE INDEX idx_comments_image_id ON comments(image_id);
CREATE INDEX idx_comments_status ON comments(status);
CREATE INDEX idx_like_logs_created_at ON like_logs(created_at DESC);
CREATE INDEX idx_comment_sync_logs_created_at ON comment_sync_logs(created_at DESC);
CREATE INDEX idx_storage_monitor_logs_created_at ON storage_monitor_logs(created_at DESC);
CREATE INDEX idx_storage_monitor_logs_alert_level ON storage_monitor_logs(alert_level);
```

---

## 文件变更清单

### 修改的文件
- `index.html` - 点赞功能改用 Edge Function API

### 新增的文件
- `supabase/functions/_shared/cors.ts` - CORS 配置
- `supabase/functions/_shared/supabaseClient.ts` - Supabase 客户端
- `supabase/functions/_shared/rateLimiter.ts` - 限流器
- `supabase/functions/like-toggle/index.ts` - 点赞 API
- `supabase/functions/comment-api/index.ts` - 评论 API
- `supabase/functions/view-count/index.ts` - 浏览量 API
- `supabase/functions/storage-monitor/index.ts` - 存储监控 API
- `supabase/database/rls_policies.sql` - RLS 策略配置
- `supabase/database/storage_monitor.sql` - 存储监控函数

---

## 部署检查清单

### 数据库配置
- [x] 执行 `rls_policies.sql` 创建 RLS 策略
- [x] 执行 `storage_monitor.sql` 创建监控函数
- [x] 验证各表 RLS 状态已启用

### Edge Functions
- [x] `like-toggle` 已部署
- [x] `comment-api` 已部署
- [x] `view-count` 已部署
- [x] `storage-monitor` 已部署

### 前端
- [ ] 将 `index.html` 重新部署到 codebuddy.work

---

## 回滚方案

如需回滚，执行以下 SQL：

```sql
-- 禁用 RLS
ALTER TABLE image_likes DISABLE ROW LEVEL SECURITY;
ALTER TABLE image_views DISABLE ROW LEVEL SECURITY;
ALTER TABLE likes DISABLE ROW LEVEL SECURITY;
ALTER TABLE comments DISABLE ROW LEVEL SECURITY;
ALTER TABLE like_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE comment_sync_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE storage_monitor_logs DISABLE ROW LEVEL SECURITY;

-- 删除触发器
DROP TRIGGER IF EXISTS update_like_count ON likes;
DROP TRIGGER IF EXISTS update_comment_count ON comments;
DROP TRIGGER IF EXISTS log_like_action ON likes;
DROP TRIGGER IF EXISTS log_comment_action ON comments;
```

---

## 联系信息

如有问题，请检查：
1. Supabase Dashboard > Edge Functions 查看函数日志
2. Supabase Dashboard > SQL Editor 执行 `SELECT * FROM storage_monitor_logs ORDER BY created_at DESC LIMIT 10;` 查看监控历史
