-- ============================================
-- 管理员系统数据库初始化
-- 1. gallery_images 表: 图片元数据(支持后台管理可见性/排序)
-- 2. admin_audit_logs 表: 管理员操作审计
-- 3. 初始化现有 15 张图片到 gallery_images
-- 4. 同步 users.role 已有用户的索引/约束
-- ============================================

-- 1. gallery_images 表
CREATE TABLE IF NOT EXISTS public.gallery_images (
  id           BIGSERIAL PRIMARY KEY,
  filename     TEXT        NOT NULL UNIQUE,            -- images/1782210152459.png 中的文件名
  title        VARCHAR(128),
  category     VARCHAR(32) NOT NULL DEFAULT 'portrait',
  is_visible   BOOLEAN     NOT NULL DEFAULT TRUE,      -- 后台可切换
  is_new       BOOLEAN     NOT NULL DEFAULT FALSE,     -- 是否显示"新作品"标签
  sort_order   INTEGER     NOT NULL DEFAULT 0,         -- 后台可拖拽排序
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gallery_visible ON public.gallery_images (is_visible, sort_order);
CREATE INDEX IF NOT EXISTS idx_gallery_category ON public.gallery_images (category);

ALTER TABLE public.gallery_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "访客可读取可见图片" ON public.gallery_images;
CREATE POLICY "访客可读取可见图片" ON public.gallery_images
  FOR SELECT TO anon, authenticated
  USING (is_visible = true);

DROP POLICY IF EXISTS "服务角色可管理图片" ON public.gallery_images;
CREATE POLICY "服务角色可管理图片" ON public.gallery_images
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 2. admin_audit_logs 表
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  admin_id     BIGINT NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  admin_name   VARCHAR(64),                            -- 冗余存储,避免用户改名后查不到
  action       VARCHAR(32)  NOT NULL,                  -- users.disable / users.delete / comments.delete / ...
  target_type  VARCHAR(32)  NOT NULL,                  -- user / comment / image
  target_id    TEXT         NOT NULL,                  -- 目标 id (字符串,兼容多种类型)
  details      JSONB,                                  -- 额外信息(JSON)
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_admin_id    ON public.admin_audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_target      ON public.admin_audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at  ON public.admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action      ON public.admin_audit_logs (action);

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "服务角色可管理审计日志" ON public.admin_audit_logs;
CREATE POLICY "服务角色可管理审计日志" ON public.admin_audit_logs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 3. 初始化现有 15 张图片到 gallery_images
-- 保留 index.html 中硬编码的 title/category/isNew 状态,后续可从后台调整
INSERT INTO public.gallery_images (filename, title, category, is_new, sort_order)
VALUES
  ('1782210152459.png', '人像作品 01', 'portrait', TRUE,  1),
  ('1782210158805.png', '人像作品 02', 'portrait', TRUE,  2),
  ('1782210635533.png', '人像作品 03', 'portrait', FALSE, 3),
  ('1782210771450.png', '人像作品 04', 'portrait', FALSE, 4),
  ('1782210897284.png', '人像作品 05', 'portrait', FALSE, 5),
  ('1782210910862.png', '人像作品 06', 'portrait', FALSE, 6),
  ('1782210999263.png', '人像作品 07', 'portrait', FALSE, 7),
  ('1782211128132.png', '人像作品 08', 'portrait', FALSE, 8),
  ('1782211157173.png', '人像作品 09', 'portrait', FALSE, 9),
  ('7afeddec7b88421123646b810764342e.jpg', '人像作品 10', 'portrait', FALSE, 10),
  ('7fc0057e819cc7f9a81da2b882e6e9a6.jpg', '人像作品 11', 'portrait', FALSE, 11),
  ('893b23a3e941a070a5a9916fdb95ea9a.jpg', '人像作品 12', 'portrait', FALSE, 12),
  ('f8bd7ec8f44cfc651eb30595a02c6c7a.jpg', '人像作品 13', 'portrait', FALSE, 13),
  ('119064098755adadd4f2ba0b34d069b1.jpg', '人像作品 14', 'portrait', FALSE, 14),
  ('122d3967ac65825bd54b528e53d5b805.jpg', '人像作品 15', 'portrait', FALSE, 15)
ON CONFLICT (filename) DO NOTHING;

-- 4. 升级 is_admin() 函数 - 同时检查 users 和 profiles 表(向后兼容)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()::text::bigint AND role = 'admin' AND is_active = true
  ) OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. 确保 users 表的 role 字段有 admin 取值检查
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'admin'));

-- ============================================
-- 部署完成后,手动将指定用户升级为管理员:
-- UPDATE public.users SET role = 'admin' WHERE username = '你的管理员账号';
-- ============================================
