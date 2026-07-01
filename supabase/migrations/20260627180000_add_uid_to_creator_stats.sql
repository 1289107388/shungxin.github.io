-- 为 creator_stats 视图增加 uid 字段
-- 注意：修改视图列结构需要先 DROP 再 CREATE
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

GRANT SELECT ON public.creator_stats TO anon, authenticated;
