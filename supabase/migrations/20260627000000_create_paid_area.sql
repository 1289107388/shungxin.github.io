-- ============================================
-- 付费区（里站）功能
-- 1. gallery_images 增加 area 字段区分公开/付费
-- 2. 创建 site_settings 表存储付费区密码哈希
-- 3. 默认密码: shungxin2025（上线后务必在后台修改）
-- 4. 安全策略: site_settings 仅 service_role 可读写
-- ============================================

-- 1. gallery_images 增加 area 字段
ALTER TABLE public.gallery_images
  ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT 'public'
  CHECK (area IN ('public', 'paid'));

CREATE INDEX IF NOT EXISTS idx_gallery_images_area_visible
  ON public.gallery_images (area, is_visible);

-- 2. 站点配置表（K/V，仅 Edge Function/service_role 访问）
CREATE TABLE IF NOT EXISTS public.site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.site_settings IS '站点级敏感配置，如付费区密码哈希';

-- 开启 RLS，不授予任何策略 -> anon/authenticated 不可读写
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

-- 3. 插入默认付费区密码（bcrypt，cost=12）
--    上线后请通过 supabase SQL Editor 或 Edge Function 重新生成并替换
INSERT INTO public.site_settings (key, value)
VALUES ('paid_area_password_hash', '$2b$12$hlcBmKGu2NLkvaIuFgs.KuunEP471Q3RqPQ9LLSM/YtQGsF3x60Se')
ON CONFLICT (key) DO NOTHING;

-- 4. 可选：强制所有现有图片归为公开区
--    如果已有图片需要迁移到付费区，请管理员在后台手动修改 area='paid'
UPDATE public.gallery_images
  SET area = 'public'
  WHERE area IS NULL OR area NOT IN ('public', 'paid');
