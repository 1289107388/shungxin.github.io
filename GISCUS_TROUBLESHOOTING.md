# Giscus 配置问题排查 — 错误："无法在该仓库上使用 giscus"

## 当前状态

- ✅ 代码已修正仓库名为 `shungxin/shungxin.github.io`
- ❌ Giscus 验证失败 — 仓库未满足三个必要条件之一

## 三个必要条件（按排查优先级排序）

### 条件 1：仓库是否存在 + 是否公开

**检查地址**：https://github.com/shungxin/shungxin.github.io

**判定标准**：
- ✅ **页面能正常打开**（不是 404）
- ✅ 仓库名前有 `Public` 标签（不是 `Private`）

**如果 404（仓库不存在）**：
```
GitHub 用户主页站点（user/org site）只能在以下情况下自动创建：
- 用户名 + ".github.io" 同名仓库
- 仓库公开（强制）

操作：
1. 访问 https://github.com/new
2. Repository name 填入：shungxin.github.io
3. 选择 Public
4. 不要勾选 Add README
5. Create repository
```

**如果是 Private**：
```
进入仓库 Settings → General → Danger Zone → Change repository visibility → Make public
```

### 条件 2：giscus app 是否安装（最常见缺失）

**检查地址**：https://github.com/shungxin/shungxin.github.io/settings/installations

**判定标准**：
- ✅ 在 "Installed GitHub Apps" 列表中能看到 **giscus**

**如果未安装**：
```
1. 访问 https://github.com/apps/giscus
2. 点击右上角 "Install" 按钮
3. 选择 "shungxin" 账户
4. 在仓库列表中找到 shungxin/shungxin.github.io
5. 勾选 → Install
6. 确认授权
```

### 条件 3：Discussions 是否启用

**检查地址**：https://github.com/shungxin/shungxin.github.io/settings

**判定标准**：
- ✅ General → Features 区域中 **Discussions** 复选框被勾选

**如果未启用**：
```
1. 访问仓库 Settings
2. 滚到 General → Features
3. 勾选 ☐ Discussions
4. 页面底部点击 "Save changes"
```

## 验证步骤

完成上述修复后，回到 https://giscus.app/zh-CN：

1. 在仓库输入框重新输入 `shungxin/shungxin.github.io`
2. 等待 1-2 秒
3. **错误应该消失**，下方应出现：
   - Discussion 分类下拉框可选择（之前显示"找不到分类"）
   - 页面下方出现完整 `<script>` 配置脚本

## 最可能的真实原因

根据常见情况，**Giscus 错误最常见的原因 = giscus app 未安装**（条件 2）。
即使仓库公开 + Discussions 已启用，缺少 giscus app 安装也会报这个错误。

## 备选方案

如果 `shungxin/shungxin.github.io` 仓库无法满足条件（例如是组织主页，权限受限），
可以改用一个**全新专用仓库**：

```bash
# 1. 创建新仓库
# 访问 https://github.com/new
# Repository name: stellar-comments
# Public + Add a README file
# Create repository

# 2. 启用 Discussions
# Settings → Features → 勾选 Discussions → Save

# 3. 安装 giscus app
# https://github.com/apps/giscus → Install → 选择 stellar-comments

# 4. 修改代码
# 把 GISCUS_CONFIG.repo 改为 'shungxin/stellar-comments'
```

## 获取真实 ID 并填入代码

修复仓库后，在 giscus.app 页面下方会显示完整脚本，例如：

```html
<script src="https://giscus.app/client.js"
        data-repo="shungxin/shungxin.github.io"
        data-repo-id="R_kgDOAbcXYZ"           ← 复制这个
        data-category="General"
        data-category-id="DIC_kwDOAbcXYZ"     ← 复制这个
        ...
></script>
```

将这两个 ID 填入：

**index.html** (约第 1700 行)：
```js
const GISCUS_CONFIG = {
  repo: 'shungxin/shungxin.github.io',
  repoId: 'R_kgDOAbcXYZ',         // ← 替换
  category: 'General',
  categoryId: 'DIC_kwDOAbcXYZ',   // ← 替换
  ...
};
```

**comments.html** (约第 440 行)：同样的两处替换。

## 提交记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-06-24 上午 | ✅ 修正仓库名 | 改为 shungxin/shungxin.github.io |
| 2026-06-24 上午 | ⏳ 等待仓库验证 | 您需执行 3 步：检查仓库/安装 app/启用 Discussions |
| 2026-06-24 待 | ⏳ 等待获取 Giscus ID | 修复后从 giscus.app 复制粘贴到代码 |
