# 点赞功能配置指南（Supabase）

## 功能说明

点赞功能已集成到网站中，支持两种模式：

1. **演示模式**（默认）：点赞数据仅存储在浏览器本地，换设备会丢失
2. **真实模式**（Supabase）：点赞数据持久化存储在云端数据库

---

## 配置 Supabase（真实模式）

### 步骤 1：注册 Supabase 账号

1. 访问 [Supabase 官网](https://supabase.com)
2. 点击「Start your project」注册账号（可用 GitHub 登录）
3. 登录后进入 Dashboard

### 步骤 2：创建项目

1. 点击「New Project」
2. 填写项目信息：
   - **Name**：`shungxin-gallery`（或任意名称）
   - **Database Password**：设置一个强密码（记住它）
   - **Region**：选择 `Northeast Asia (Tokyo)` 或 `Southeast Asia (Singapore)`（离中国较近）
3. 点击「Create new project」，等待约 2 分钟初始化完成

### 步骤 3：获取 API 密钥

1. 进入项目 → Settings → API
2. 复制以下信息：
   - **Project URL**：类似 `https://xxx.supabase.co`
   - **anon public key**：类似 `eyJhbGciOiJIUzI1NiIsInR5cCI6...`（公开密钥，前端可用）

### 步骤 4：创建数据表

1. 进入项目 → Table Editor
2. 点击「Create a new table」
3. 填写表名：`image_likes`
4. 添加字段：
   | 字段名 | 类型 | 说明 |
   |--------|------|------|
   | `id` | int8 | 主键，自动生成 |
   | `image_id` | text | 图片 ID（对应 imageData 中的 id） |
   | `count` | int4 | 点赞数 |
5. 点击「Save」保存

### 步骤 5：设置 Row Level Security (RLS)

为了允许匿名用户读写点赞数据，需要配置 RLS：

1. 进入项目 → SQL Editor
2. 点击「New query」
3. 执行以下 SQL：

```sql
-- 启用 RLS
ALTER TABLE image_likes ENABLE ROW LEVEL SECURITY;

-- 允许所有人读取点赞数
CREATE POLICY "Allow public read access" ON image_likes
  FOR SELECT
  USING (true);

-- 允许所有人写入点赞数
CREATE POLICY "Allow public write access" ON image_likes
  FOR ALL
  USING (true)
  WITH CHECK (true);
```

4. 点击「Run」执行

### 步骤 6：修改代码配置

打开 `index.html`，找到 `SUPABASE_CONFIG` 配置块（约第 2003 行）：

```javascript
const SUPABASE_CONFIG = {
  url: 'YOUR_SUPABASE_URL',        // 替换为你的 Supabase URL
  anonKey: 'YOUR_SUPABASE_ANON_KEY', // 替换为你的 anon key
};
```

替换为你的真实配置：

```javascript
const SUPABASE_CONFIG = {
  url: 'https://xxx.supabase.co',        // 你的 Project URL
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6...', // 你的 anon public key
};
```

---

## 验证配置

配置完成后，打开浏览器控制台（F12），输入：

```javascript
console.log(window.supabaseReady)
```

- 返回 `true`：Supabase 已成功初始化
- 返回 `false`：配置未生效，检查 URL 和 anonKey 是否正确

---

## 功能特性

- ✅ 点赞按钮显示在每张图片左上角（心形图标）
- ✅ 点赞后图标变红，显示点赞数
- ✅ 支持取消点赞
- ✅ 点赞状态存储在 localStorage（防止同一浏览器重复点赞）
- ✅ 演示模式自动生成随机点赞数
- ✅ 真实模式数据持久化到 Supabase PostgreSQL

---

## Supabase 免费额度

Supabase 免费版包含：
- **500MB** 数据库存储
- **5GB** 带宽/月
- **50MB** 文件存储
- **50,000** 月活用户

对于个人博客/画廊的点赞功能，这些额度完全足够。

---

## 部署步骤

1. 配置 Supabase（按上述步骤）
2. 将修改后的 `index.html` 上传到你的托管平台
3. 访问网站验证点赞功能

---

## 常见问题

### Q: 点赞后提示「演示模式」？

A: 说明 Supabase 未配置成功，检查：
- Project URL 是否正确（包含 `https://`）
- anonKey 是否完整复制
- 数据表 `image_likes` 是否已创建
- RLS 策略是否已执行

### Q: 点赞数不显示？

A: 检查：
- Supabase 数据表是否已创建
- RLS 策略是否允许公开读取
- 浏览器控制台是否有错误信息

### Q: Supabase 国内访问慢？

A: 选择 Tokyo 或 Singapore 区域可获得较好速度。如仍慢，可考虑：
- 使用 CloudBase（腾讯云开发）
- 自建后端 API

---

## 数据表结构参考

```sql
CREATE TABLE image_likes (
  id BIGSERIAL PRIMARY KEY,
  image_id TEXT UNIQUE NOT NULL,
  count INTEGER DEFAULT 0
);

-- 初始化一些测试数据
INSERT INTO image_likes (image_id, count) VALUES
  ('1', 42),
  ('2', 35),
  ('3', 28);
```