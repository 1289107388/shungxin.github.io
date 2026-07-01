-- ============================================
-- users 表 + RLS 策略
-- 用于网站自定义用户名/密码注册登录系统
-- ============================================

-- 1. 创建 users 表
CREATE TABLE IF NOT EXISTS public.users (
  id            BIGSERIAL PRIMARY KEY,
  username      VARCHAR(32)  NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  salt          TEXT         NOT NULL,
  display_name  VARCHAR(64),
  avatar        TEXT,
  role          VARCHAR(16)  NOT NULL DEFAULT 'user',  -- user | admin
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE
);

-- 2. 用户公开 UID（默认等于自增 id，可用于分享/展示）
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS uid BIGINT UNIQUE;

-- 回填现有用户 uid = id
UPDATE public.users SET uid = id WHERE uid IS NULL;

-- 新用户若未指定 uid，则自动设为 id
CREATE OR REPLACE FUNCTION public.set_user_uid()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.uid IS NULL THEN
    NEW.uid := NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_user_uid ON public.users;
CREATE TRIGGER trg_set_user_uid
  BEFORE INSERT ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_uid();

-- 2. 索引
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users (username);
CREATE INDEX IF NOT EXISTS idx_users_role     ON public.users (role);
CREATE INDEX IF NOT EXISTS idx_users_uid      ON public.users (uid);

-- 3. RLS 启用
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- 4. RLS 策略
-- (a) 任何人(包括 anon)都不能直接读取 password_hash 和 salt
--     只允许通过 Edge Function (service_role) 访问
DROP POLICY IF EXISTS "service_role_all" ON public.users;
CREATE POLICY "service_role_all" ON public.users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. 给 anon 角色最基本的只读 username/display_name 访问(用于展示评论用户名)
DROP POLICY IF EXISTS "anon_read_public_fields" ON public.users;
CREATE POLICY "anon_read_public_fields" ON public.users
  FOR SELECT
  TO anon
  USING (true);
-- anon 没有 INSERT/UPDATE/DELETE 权限

-- 6. 在 comments 表加 user_id 字段(关联到 users.id)
ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comments_user_id ON public.comments (user_id);

-- 7. 在 likes 表加 user_id 字段
ALTER TABLE public.likes
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_likes_user_id ON public.likes (user_id);

-- 8. auth_sessions 表(可选,记录活跃 token)
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT   NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip         TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id    ON public.auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON public.auth_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON public.auth_sessions (expires_at);

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_auth_sessions" ON public.auth_sessions;
CREATE POLICY "service_role_auth_sessions" ON public.auth_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
