-- ============================
-- RLS 权限策略配置
-- 三层架构兜底防护：即便接口被绕过，数据库层也要限制
-- ============================

-- 1. 启用所有表的 RLS
ALTER TABLE image_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE like_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensitive_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_monitor_logs ENABLE ROW LEVEL SECURITY;

-- 2. 删除旧策略（如果存在）
DROP POLICY IF EXISTS "访客可读取点赞计数" ON image_likes;
DROP POLICY IF EXISTS "仅服务角色可修改点赞计数" ON image_likes;
DROP POLICY IF EXISTS "访客可读取浏览量" ON image_views;
DROP POLICY IF EXISTS "仅服务角色可修改浏览量" ON image_views;
DROP POLICY IF EXISTS "用户只能操作自己的点赞" ON likes;
DROP POLICY IF EXISTS "访客可读取评论" ON comments;
DROP POLICY IF EXISTS "认证用户可创建评论" ON comments;
DROP POLICY IF EXISTS "仅管理员可删除评论" ON comments;
DROP POLICY IF EXISTS "访客可读取用户资料" ON profiles;
DROP POLICY IF EXISTS "用户可修改自己的资料" ON profiles;
DROP POLICY IF EXISTS "仅服务角色可读取日志" ON like_logs;
DROP POLICY IF EXISTS "仅服务角色可读取同步日志" ON comment_sync_logs;
DROP POLICY IF EXISTS "访客可读取敏感词" ON sensitive_words;
DROP POLICY IF EXISTS "仅服务角色可管理敏感词" ON sensitive_words;
DROP POLICY IF EXISTS "仅服务角色可读取监控日志" ON storage_monitor_logs;

-- 3. image_likes 表策略（点赞计数）
-- 访客只读
CREATE POLICY "访客可读取点赞计数"
  ON image_likes FOR SELECT
  TO anon, authenticated
  USING (true);

-- 仅服务角色（Edge Functions）可修改
CREATE POLICY "仅服务角色可修改点赞计数"
  ON image_likes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. image_views 表策略（浏览量）
CREATE POLICY "访客可读取浏览量"
  ON image_views FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "仅服务角色可修改浏览量"
  ON image_views FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. likes 表策略（点赞明细）
-- 访客可读
CREATE POLICY "访客可读取点赞明细"
  ON likes FOR SELECT
  TO anon, authenticated
  USING (true);

-- 用户只能插入/删除自己的点赞
CREATE POLICY "用户只能操作自己的点赞"
  ON likes FOR ALL
  TO authenticated
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- 服务角色可全部操作
CREATE POLICY "服务角色可管理点赞明细"
  ON likes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 6. comments 表策略（评论）
-- 访客可读已审核评论
CREATE POLICY "访客可读取已审核评论"
  ON comments FOR SELECT
  TO anon, authenticated
  USING (status = 'approved');

-- 认证用户可创建评论
CREATE POLICY "认证用户可创建评论"
  ON comments FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- 用户只能修改自己的评论
CREATE POLICY "用户只能修改自己的评论"
  ON comments FOR UPDATE
  TO authenticated
  USING (github_username = auth.uid()::text OR user_id = auth.uid())
  WITH CHECK (github_username = auth.uid()::text OR user_id = auth.uid());

-- 仅管理员可删除评论（通过 Edge Function 鉴权）
CREATE POLICY "仅管理员可删除评论"
  ON comments FOR DELETE
  TO service_role
  USING (true);

-- 7. profiles 表策略（用户资料）
CREATE POLICY "访客可读取用户资料"
  ON profiles FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "用户可修改自己的资料"
  ON profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- 8. like_logs 表策略（操作日志）
-- 仅服务角色可读写
CREATE POLICY "仅服务角色可管理日志"
  ON like_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 9. comment_sync_logs 表策略（同步日志）
CREATE POLICY "仅服务角色可管理同步日志"
  ON comment_sync_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 10. sensitive_words 表策略（敏感词）
CREATE POLICY "访客可读取敏感词"
  ON sensitive_words FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "仅服务角色可管理敏感词"
  ON sensitive_words FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 11. storage_monitor_logs 表策略（存储监控）
CREATE POLICY "仅服务角色可管理监控日志"
  ON storage_monitor_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 12. 创建管理员角色检查函数
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
