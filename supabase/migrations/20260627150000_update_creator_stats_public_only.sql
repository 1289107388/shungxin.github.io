-- 更新 creator_stats 视图：仅统计公开区(area='public')作品
-- 修复付费区图片在个人资料作品页和创作者统计中泄露的问题
CREATE OR REPLACE VIEW public.creator_stats AS
SELECT
  u.id,
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
GROUP BY u.id, u.username, u.display_name, u.avatar, u.bio, u.role, u.created_at;

-- 增加 area 索引，加速公开区作品过滤
CREATE INDEX IF NOT EXISTS idx_gallery_images_uploaded_by_visible_area
  ON public.gallery_images (uploaded_by, is_visible, area);
