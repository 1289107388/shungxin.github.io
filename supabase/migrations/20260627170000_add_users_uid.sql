-- 为用户表新增 uid 字段
-- uid 默认等于自增 id，作为公开用户编码使用
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_uid ON public.users (uid);

-- 确保公开字段策略能读取 uid
DROP POLICY IF EXISTS "anon_read_public_fields" ON public.users;
CREATE POLICY "anon_read_public_fields" ON public.users
  FOR SELECT
  TO anon
  USING (true);
