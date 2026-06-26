-- ============================================
-- 移除游客点赞/浏览功能：仅登录用户可点赞、计浏览量
-- 1. 清理 likes 表中游客记录，并将 user_id 统一为 BIGINT 关联 users.id
-- 2. 新增 image_view_records 表，用于按登录用户去重浏览量
-- 3. 更新相关 RLS 策略（写入仍由 Edge Function 通过 service_role 完成）
-- ============================================

-- 1. 兼容历史：如果 likes 表不存在则创建（初始 user_id 用 text，后面再改类型）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'likes'
  ) THEN
    CREATE TABLE public.likes (
      id         BIGSERIAL PRIMARY KEY,
      image_id   BIGINT      NOT NULL,
      user_id    TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (image_id, user_id)
    );
  END IF;
END $$;

-- 2. 确保 likes.user_id 字段存在
ALTER TABLE public.likes ADD COLUMN IF NOT EXISTS user_id TEXT;

-- 3. 如果 likes.user_id 仍是 text，清理游客记录并改成 BIGINT
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'likes'
      AND column_name  = 'user_id'
      AND data_type    = 'text'
  ) THEN
    -- 清理旧逻辑产生的 visitor_xxx / user_xxx
    DELETE FROM public.likes
    WHERE user_id LIKE 'visitor_%'
       OR user_id LIKE 'user_%';

    -- 先删除默认值，避免类型转换时报 "default cannot be cast"
    ALTER TABLE public.likes ALTER COLUMN user_id DROP DEFAULT;

    -- 兜底清理无法转换为数字的字符串
    DELETE FROM public.likes WHERE user_id !~ '^[0-9]+$';

    ALTER TABLE public.likes
      ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;
  END IF;
END $$;

-- 5. 确保 (image_id, user_id) 唯一约束存在（upsert 需要）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.likes'::regclass
      AND conname = 'likes_image_user_unique'
  ) THEN
    ALTER TABLE public.likes
      ADD CONSTRAINT likes_image_user_unique
      UNIQUE (image_id, user_id);
  END IF;
END $$;

-- 6. 确保 likes.user_id 为 NOT NULL 并关联 users.id
ALTER TABLE public.likes ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.likes
  DROP CONSTRAINT IF EXISTS likes_user_id_fkey;
ALTER TABLE public.likes
  ADD CONSTRAINT likes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 6. 索引
CREATE INDEX IF NOT EXISTS idx_likes_image_id ON public.likes (image_id);
CREATE INDEX IF NOT EXISTS idx_likes_user_id  ON public.likes (user_id);

-- 7. 启用 RLS（如未启用）
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;

-- 8. 写入只由 Edge Function（service_role）完成
DROP POLICY IF EXISTS "service_role_manage_likes" ON public.likes;
CREATE POLICY "service_role_manage_likes"
  ON public.likes FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- 9. 新增 image_view_records 表：记录登录用户已浏览的图片，用于去重
CREATE TABLE IF NOT EXISTS public.image_view_records (
  id         BIGSERIAL PRIMARY KEY,
  image_id   BIGINT      NOT NULL,
  user_id    BIGINT      NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (image_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_image_view_records_image_id  ON public.image_view_records (image_id);
CREATE INDEX IF NOT EXISTS idx_image_view_records_user_id   ON public.image_view_records (user_id);
CREATE INDEX IF NOT EXISTS idx_image_view_records_viewed_at ON public.image_view_records (viewed_at DESC);

-- 10. image_view_records RLS
ALTER TABLE public.image_view_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_manage_image_view_records" ON public.image_view_records;
CREATE POLICY "service_role_manage_image_view_records"
  ON public.image_view_records FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- 11. image_views 计数表保持公开读取（已有策略无需重复创建）
