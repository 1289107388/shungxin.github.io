-- ============================================
-- Supabase Storage: gallery-images 桶初始化
-- 公开读(图片资源),写需 admin 鉴权(通过 Edge Function)
-- ============================================

-- 1. 创建 bucket (Supabase Storage 概念上的"文件夹/桶")
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gallery-images',
  'gallery-images',
  true,                       -- 公开读(主站前台 <img> 直接访问)
  10485760,                   -- 10MB 上限(原始图,Edge Function 内还会压成 ~300KB WebP)
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. RLS 策略
-- (a) 任何人(包括 anon)都能 SELECT 公开 bucket
--    (Supabase 默认 public bucket 已经允许 SELECT,这里加显式策略方便以后改成私有时容易回滚)
DROP POLICY IF EXISTS "公开读 gallery-images" ON storage.objects;
CREATE POLICY "公开读 gallery-images"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'gallery-images');

-- (b) 写入/删除: 只允许 service_role (Edge Function 用 service key 走)
--    这样普通用户无法直接 upload,必须经我们的 Edge Function 鉴权后调用
DROP POLICY IF EXISTS "service_role 写 gallery-images" ON storage.objects;
CREATE POLICY "service_role 写 gallery-images"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'gallery-images')
  WITH CHECK (bucket_id = 'gallery-images');

-- 3. 给 gallery_images 表加 storage 相关字段(新老图兼容)
ALTER TABLE public.gallery_images
  ADD COLUMN IF NOT EXISTS storage_path TEXT,           -- 例如 '2026/06/25/abc123.webp' (相对 bucket 根)
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT,        -- 例如 'gallery-images'
  ADD COLUMN IF NOT EXISTS width INTEGER,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL;  -- 用户上传:记录上传者

-- 4b. 索引: 按 uploaded_by 查询某用户上传的图(限流/统计用)
CREATE INDEX IF NOT EXISTS idx_gallery_uploaded_by ON public.gallery_images (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_gallery_created_at ON public.gallery_images (created_at DESC);

-- 4. 视图: 把 storage_path 拼成完整 public URL (供前端用)
--    不污染原表,前端查询改读这个视图即可
CREATE OR REPLACE VIEW public.gallery_images_view AS
SELECT
  id,
  filename,
  title,
  category,
  is_visible,
  is_new,
  sort_order,
  description,
  created_at,
  updated_at,
  width, height, size_bytes, mime_type,
  storage_path, storage_bucket,
  -- 老图(local): 返回 NULL(前端识别 NULL 后用 images/<filename>)
  -- 新图(storage): 返回 https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
  CASE
    WHEN storage_path IS NOT NULL AND storage_bucket IS NOT NULL THEN
      'https://qlhfyawbyedhqokivezn.supabase.co/storage/v1/object/public/'
      || storage_bucket || '/' || storage_path
    ELSE NULL
  END AS src
FROM public.gallery_images;

-- 5. 授权匿名读视图
GRANT SELECT ON public.gallery_images_view TO anon, authenticated;

-- ============================================
-- 完成后: 手动去 Supabase Dashboard > Storage > gallery-images
-- 确认 bucket 已建好,再去 admin.html 测试上传
-- ============================================
