-- ============================
-- 存储容量监控与数据清理
-- 适配 500MB 免费数据库额度
-- ============================

-- 1. 创建存储监控日志表（如果不存在）
CREATE TABLE IF NOT EXISTS storage_monitor_logs (
  id SERIAL PRIMARY KEY,
  usage_mb NUMERIC(10,2) NOT NULL,
  limit_mb NUMERIC(10,2) NOT NULL DEFAULT 500,
  usage_percent NUMERIC(5,2) NOT NULL,
  alert_level TEXT NOT NULL CHECK (alert_level IN ('normal', 'warning', 'critical')),
  tables_snapshot JSONB,
  recommendations JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 创建表大小查询函数（供 Edge Function 调用）
CREATE OR REPLACE FUNCTION get_table_sizes()
RETURNS TABLE (
  table_name TEXT,
  size_bytes BIGINT,
  row_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.relname::TEXT AS table_name,
    pg_total_relation_size(c.oid)::BIGINT AS size_bytes,
    c.reltuples::BIGINT AS row_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. 创建数据库总大小查询函数
CREATE OR REPLACE FUNCTION get_database_size_mb()
RETURNS NUMERIC AS $$
DECLARE
  size_bytes BIGINT;
BEGIN
  SELECT pg_database_size(current_database()) INTO size_bytes;
  RETURN ROUND(size_bytes::NUMERIC / 1024 / 1024, 2);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 创建数据清理函数：清理过期日志
CREATE OR REPLACE FUNCTION cleanup_expired_logs(
  days_to_keep INTEGER DEFAULT 90
)
RETURNS TABLE (
  table_name TEXT,
  deleted_count INTEGER
) AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  deleted_rows INTEGER;
BEGIN
  cutoff_date := NOW() - (days_to_keep || ' days')::INTERVAL;

  -- 清理 like_logs
  DELETE FROM like_logs WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN QUERY SELECT 'like_logs'::TEXT, deleted_rows;

  -- 清理 comment_sync_logs
  DELETE FROM comment_sync_logs WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN QUERY SELECT 'comment_sync_logs'::TEXT, deleted_rows;

  -- 清理 storage_monitor_logs（保留最近100条）
  DELETE FROM storage_monitor_logs
  WHERE id NOT IN (
    SELECT id FROM storage_monitor_logs
    ORDER BY created_at DESC
    LIMIT 100
  );
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN QUERY SELECT 'storage_monitor_logs'::TEXT, deleted_rows;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. 创建数据清理函数：清理已删除/拒绝的评论
CREATE OR REPLACE FUNCTION cleanup_rejected_comments(
  days_to_keep INTEGER DEFAULT 30
)
RETURNS INTEGER AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  deleted_count INTEGER;
BEGIN
  cutoff_date := NOW() - (days_to_keep || ' days')::INTERVAL;

  DELETE FROM comments
  WHERE status IN ('rejected', 'spam', 'deleted')
    AND updated_at < cutoff_date;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. 创建综合清理函数（定时任务调用）
CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS TABLE (
  operation TEXT,
  details TEXT
) AS $$
DECLARE
  log_result RECORD;
  comment_count INTEGER;
  db_size_before NUMERIC;
  db_size_after NUMERIC;
BEGIN
  -- 记录清理前大小
  db_size_before := get_database_size_mb();

  -- 清理过期日志
  FOR log_result IN SELECT * FROM cleanup_expired_logs(90)
  LOOP
    RETURN QUERY SELECT
      '清理日志'::TEXT,
      log_result.table_name || ': 删除 ' || log_result.deleted_count || ' 条记录';
  END LOOP;

  -- 清理已删除评论
  comment_count := cleanup_rejected_comments(30);
  RETURN QUERY SELECT
    '清理评论'::TEXT,
    '删除已拒绝/垃圾评论: ' || comment_count || ' 条';

  -- 记录清理后大小
  db_size_after := get_database_size_mb();
  RETURN QUERY SELECT
    '空间回收'::TEXT,
    '清理前: ' || db_size_before || 'MB, 清理后: ' || db_size_after || 'MB, 回收: ' ||
    ROUND(db_size_before - db_size_after, 2) || 'MB';

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. 创建存储告警检查函数
CREATE OR REPLACE FUNCTION check_storage_alert()
RETURNS TABLE (
  alert_level TEXT,
  usage_mb NUMERIC,
  usage_percent NUMERIC,
  message TEXT
) AS $$
DECLARE
  current_usage_mb NUMERIC;
  current_percent NUMERIC;
  alert_msg TEXT;
  level TEXT;
BEGIN
  current_usage_mb := get_database_size_mb();
  current_percent := ROUND((current_usage_mb / 500) * 100, 2);

  IF current_usage_mb >= 480 THEN
    level := 'critical';
    alert_msg := '🚨 存储空间严重不足！当前使用 ' || current_usage_mb || 'MB (' || current_percent || '%)。请立即执行 cleanup_expired_data() 清理数据。';
  ELSIF current_usage_mb >= 450 THEN
    level := 'warning';
    alert_msg := '⚠️ 存储空间即将不足。当前使用 ' || current_usage_mb || 'MB (' || current_percent || '%)。建议提前清理过期日志。';
  ELSE
    level := 'normal';
    alert_msg := '✅ 存储空间正常。当前使用 ' || current_usage_mb || 'MB (' || current_percent || '%)。';
  END IF;

  -- 记录到监控日志
  INSERT INTO storage_monitor_logs (usage_mb, limit_mb, usage_percent, alert_level, recommendations)
  VALUES (current_usage_mb, 500, current_percent, level, JSONB_BUILD_ARRAY(alert_msg));

  RETURN QUERY SELECT level, current_usage_mb, current_percent, alert_msg;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. 为 storage_monitor_logs 表添加索引
CREATE INDEX IF NOT EXISTS idx_storage_monitor_logs_created_at
  ON storage_monitor_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storage_monitor_logs_alert_level
  ON storage_monitor_logs(alert_level);
