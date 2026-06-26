-- ============================
-- P0-1.2 Step A: RLS 权限收紧补完 (v2 修复版)
-- 修复:
--   1. users 表字段名 avatar_url -> avatar
--   2. users 表已有 anon_read_public_fields 策略,需要先 drop 再加收紧版
--   3. comments 表字段不确定,本轮不收紧列级(留给下一轮)
--   4. 全部语句幂等,可重复执行
-- ============================

-- ===== 1. gallery_images 表 =====
ALTER TABLE public.gallery_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_public_gallery"   ON public.gallery_images;
DROP POLICY IF EXISTS "anon_select_visible_gallery"  ON public.gallery_images;
DROP POLICY IF EXISTS "service_all_gallery"          ON public.gallery_images;

CREATE POLICY "anon_select_visible_gallery"
  ON public.gallery_images FOR SELECT
  TO anon, authenticated
  USING (is_visible = true);

CREATE POLICY "service_all_gallery"
  ON public.gallery_images FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ===== 2. users 表(账号系统) =====
--   1) drop 旧的宽松 anon_read_public_fields(它允许读 password_hash)
--   2) 加收紧版:is_active=true 才看得到 + 列级 GRANT 排除敏感字段
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "anon_read_public_fields"   ON public.users;
    DROP POLICY IF EXISTS "anon_select_public_users"  ON public.users;
    DROP POLICY IF EXISTS "anon_select_active_users"  ON public.users;
    DROP POLICY IF EXISTS "service_all_users"         ON public.users;
    DROP POLICY IF EXISTS "service_role_all"          ON public.users;

    CREATE POLICY "anon_select_active_users"
      ON public.users FOR SELECT
      TO anon, authenticated
      USING (is_active = true);

    CREATE POLICY "service_all_users"
      ON public.users FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);

    -- 列级 GRANT:anon 只能 SELECT 公开字段,完全看不到 password_hash / salt / last_login_at
    -- 字段名以 create_users_table.sql 为准:avatar(不是 avatar_url)
    REVOKE ALL ON public.users FROM anon;
    GRANT SELECT (id, username, display_name, avatar, role, is_active, created_at)
      ON public.users TO anon, authenticated;
  END IF;
END $$;

-- ===== 3. admin_audit_logs 表(管理日志) =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'admin_audit_logs') THEN
    ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "anon_select_audit_logs"   ON public.admin_audit_logs;
    DROP POLICY IF EXISTS "service_all_audit_logs"   ON public.admin_audit_logs;

    CREATE POLICY "service_all_audit_logs"
      ON public.admin_audit_logs FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ===== 4. gallery_images_view 视图授权 =====
GRANT SELECT ON public.gallery_images_view TO anon, authenticated;

-- ===== 5. comments 表:暂不收紧列级(字段未对齐,留到下一轮) =====
-- 已有 RLS policy "访客可读取已审核评论" 限制 USING (status='approved') 足够
-- 下一轮单独处理列级 GRANT

-- ===== 6. sensitive_words 表(敏感词表) =====
-- 前端不需要看到词库
REVOKE ALL ON public.sensitive_words FROM anon;
REVOKE ALL ON public.sensitive_words FROM authenticated;

-- ===== 7. storage.objects 公开读策略(确认) =====
-- gallery-images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = '公开读 gallery-images'
  ) THEN
    CREATE POLICY "公开读 gallery-images"
      ON storage.objects FOR SELECT
      TO anon, authenticated
      USING (bucket_id = 'gallery-images');
  END IF;
END $$;

-- site bucket (前端静态托管)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = '公开读 site'
  ) THEN
    CREATE POLICY "公开读 site"
      ON storage.objects FOR SELECT
      TO anon, authenticated
      USING (bucket_id = 'site');
  END IF;
END $$;

-- ===== 8. 冒烟测试 SQL(注释,跑完上面再手动跑下面验证) =====
-- 切换到 anon 角色: SET LOCAL ROLE anon;
-- 查 gallery_images: SELECT id, title, is_visible FROM gallery_images;   -- 应只看到 is_visible=true
-- 查 users:          SELECT id, username FROM users;                     -- 应只看到 is_active=true 的行
-- 查 users 敏感列:    SELECT password_hash FROM users;                     -- 应报错:permission denied
-- 查 admin_audit_logs: SELECT * FROM admin_audit_logs;                    -- 应报错:permission denied
-- 切回去: RESET ROLE;
