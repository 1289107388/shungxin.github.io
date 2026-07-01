-- 图片合集（相册）功能
-- 支持公开区/付费区、封面、排序、可见性控制

-- 1. 合集主表
CREATE TABLE IF NOT EXISTS collections (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  cover_image_id BIGINT REFERENCES gallery_images(id) ON DELETE SET NULL,
  area VARCHAR(16) NOT NULL DEFAULT 'public' CHECK (area IN ('public', 'paid')),
  is_visible BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 99,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 合集与图片关联表（支持排序）
CREATE TABLE IF NOT EXISTS collection_images (
  id BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  image_id BIGINT NOT NULL REFERENCES gallery_images(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 99,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (collection_id, image_id)
);

-- 3. 索引
CREATE INDEX IF NOT EXISTS idx_collections_area_visible ON collections(area, is_visible, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_collections_created_by ON collections(created_by);
CREATE INDEX IF NOT EXISTS idx_collection_images_collection ON collection_images(collection_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_collection_images_image ON collection_images(image_id);

-- 4. 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_collections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_collections_updated_at ON collections;
CREATE TRIGGER trg_collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION update_collections_updated_at();

-- 5. RLS
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collections_select_public ON collections;
CREATE POLICY collections_select_public ON collections
  FOR SELECT USING (is_visible = true);

-- 管理员操作通过 Edge Function (service_role) 完成，service_role 默认绕过 RLS；
-- 本项目使用自定义 HMAC 认证，public.users.id 为 BIGINT，与 auth.uid() (UUID) 类型不匹配，
-- 因此不通过 auth.uid() 校验管理员身份。
DROP POLICY IF EXISTS collections_select_admin ON collections;
DROP POLICY IF EXISTS collections_manage_admin ON collections;

DROP POLICY IF EXISTS collection_images_select_public ON collection_images;
CREATE POLICY collection_images_select_public ON collection_images
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM collections c WHERE c.id = collection_images.collection_id AND c.is_visible = true)
  );

DROP POLICY IF EXISTS collection_images_select_admin ON collection_images;
DROP POLICY IF EXISTS collection_images_manage_admin ON collection_images;

-- 6. 视图：合集统计
DROP VIEW IF EXISTS collection_stats;
CREATE VIEW collection_stats AS
SELECT
  c.id,
  c.name,
  c.area,
  c.is_visible,
  COUNT(ci.image_id) AS image_count,
  COALESCE(SUM(iv.count), 0) AS total_views,
  COALESCE(SUM(il.count), 0) AS total_likes
FROM collections c
LEFT JOIN collection_images ci ON ci.collection_id = c.id
LEFT JOIN gallery_images gi ON gi.id = ci.image_id
LEFT JOIN image_views iv ON iv.image_id::bigint = gi.id
LEFT JOIN image_likes il ON il.image_id::bigint = gi.id
GROUP BY c.id, c.name, c.area, c.is_visible;
