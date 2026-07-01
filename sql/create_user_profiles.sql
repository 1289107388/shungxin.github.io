-- ============================================
-- 用户资料 + 创作者发现功能增强
-- 1. users 表增加 bio 字段
-- 2. 创建 creator_stats 视图(每位创作者的作品数/总点赞/总浏览)
-- 3. 索引优化
-- ============================================

-- 1. 用户简介字段
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bio TEXT;

-- 2. 创作者统计视图(供 user-api / 创作者发现页使用)
--    包含所有用户；仅统计已上架(is_visible=true)且公开区(area='public')的作品，无作品用户统计为 0
DROP VIEW IF EXISTS public.creator_stats;
CREATE VIEW public.creator_stats AS
SELECT
  u.id,
  u.uid,
  u.username,
  u.display_name,
  u.avatar,
  u.bio,
  u.role,
  u.created_at,
  COUNT(DISTINCT gi.id) FILTER (WHERE gi.id IS NOT NULL) AS works_count,
  COALESCE(SUM(il.count) FILTER (WHERE gi.area = 'public' OR gi.area IS NULL), 0)::bigint AS total_likes,
  COALESCE(SUM(iv.count) FILTER (WHERE gi.area = 'public' OR gi.area IS NULL), 0)::bigint AS total_views
FROM public.users u
LEFT JOIN public.gallery_images gi
  ON gi.uploaded_by::bigint = u.id AND gi.is_visible = true AND gi.area = 'public'
LEFT JOIN public.image_likes il
  ON il.image_id::bigint = gi.id
LEFT JOIN public.image_views iv
  ON iv.image_id::bigint = gi.id
GROUP BY u.id, u.uid, u.username, u.display_name, u.avatar, u.bio, u.role, u.created_at;

-- 3. 索引(加速创作者排名/搜索)
CREATE INDEX IF NOT EXISTS idx_gallery_images_uploaded_by_visible
  ON public.gallery_images (uploaded_by, is_visible);
CREATE INDEX IF NOT EXISTS idx_gallery_images_uploaded_by_visible_area
  ON public.gallery_images (uploaded_by, is_visible, area);

-- 4. 授权匿名读取统计视图(配合 Edge Function service_role 可跳过 RLS;给未来可能直连留权限)
GRANT SELECT ON public.creator_stats TO anon, authenticated;
