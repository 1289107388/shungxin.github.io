-- ============================================
-- 评论点赞 + 回复 功能增强
-- 1. comments 表增加 reply_to_username 字段（记录"回复 @谁"）
-- 2. 新建 comment_likes 表（评论点赞明细）
-- 3. RLS 策略
-- ============================================

-- 1. 评论表增加 reply_to_username 字段（可选）
ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS reply_to_username TEXT;

-- 2. comment_likes 评论点赞明细表
CREATE TABLE IF NOT EXISTS public.comment_likes (
  id          BIGSERIAL PRIMARY KEY,
  comment_id  BIGINT      NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL,             -- 访客 ID 或登录用户 ID
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comment_id, user_id)                   -- 同一用户对同一评论只能点一次
);

-- 3. 索引
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON public.comment_likes (comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user_id    ON public.comment_likes (user_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_created_at ON public.comment_likes (created_at DESC);

-- 4. RLS
ALTER TABLE public.comment_likes ENABLE ROW LEVEL SECURITY;

-- 删除旧策略（若存在）
DROP POLICY IF EXISTS "访客可读取评论点赞明细" ON public.comment_likes;
DROP POLICY IF EXISTS "服务角色可管理评论点赞"   ON public.comment_likes;

-- 所有人可读（用于 liked_by_me 判断）
CREATE POLICY "访客可读取评论点赞明细"
  ON public.comment_likes FOR SELECT
  TO anon, authenticated
  USING (true);

-- 写入 / 删除都交给 Edge Function（service_role 绕过 RLS）
CREATE POLICY "服务角色可管理评论点赞"
  ON public.comment_likes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. comments.likes_count 默认值兜底（历史数据若为 NULL 视为 0）
UPDATE public.comments SET likes_count = 0 WHERE likes_count IS NULL;

-- 6. 同步现有 likes_count：从 comment_likes 表回填（仅在 comment_likes 已有数据时执行）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'comment_likes') THEN
    UPDATE public.comments c
    SET likes_count = COALESCE(sub.cnt, 0)
    FROM (
      SELECT comment_id, COUNT(*)::int AS cnt
      FROM public.comment_likes
      GROUP BY comment_id
    ) sub
    WHERE c.id = sub.comment_id
      AND c.likes_count <> COALESCE(sub.cnt, 0);
  END IF;
END $$;

-- 7. 索引：加速按 image_id + parent_id 查询顶级评论 / 子评论
CREATE INDEX IF NOT EXISTS idx_comments_image_parent ON public.comments (image_id, parent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id    ON public.comments (parent_id);
