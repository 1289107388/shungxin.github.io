# Giscus 真实模式升级指南

## 当前状态

- ✅ **代码已升级**到 v7 真实模式（直接嵌入 Giscus iframe，无需跨窗口跳转）
- ✅ **配置引导界面**自动检测占位符，未配置时显示清晰的 4 步引导
- ✅ **控制台配置检查器**自动输出当前状态 + 配置步骤
- ⏳ **等待 Giscus ID** — 需访问 https://giscus.app/zh-CN 获取后填入

## 修改概览

| 文件 | 变更 |
|---|---|
| `index.html` | 重写 v7：直接嵌入 Giscus iframe + 配置检测 + 占位符引导 |
| `comments.html` | 重写为纯 Giscus 嵌入子站：默认 Giscus 模式 + ?demo=1 演示模式回退 |

## 配置步骤（必做）

### 第 1 步：创建并启用 Discussions 的 GitHub 仓库

```
# 选项 A：复用 shungxin.github.io 主仓库
# 访问 https://github.com/shungxin/shungxin.github.io/settings
# 勾选 Features 区域的 "Discussions" → Save

# 选项 B：创建独立仓库
# 访问 https://github.com/new
# Repo name: stellar-comments (或任意)
# Public + Add README
# Settings → Features → 勾选 Discussions
```

### 第 2 步：获取 Giscus 配置 ID

打开 **https://giscus.app/zh-CN** ，按以下填写：

| 配置项 | 填入值 |
|---|---|
| **语言** | `简体中文 (zh-CN)` |
| **仓库** | `shungxin/shungxin.github.io`（或你的仓库） |
| **页面 ↔ Discussion 映射** | `Discussion 标题包含特定 term` |
| **Discussion 分类** | `General` 或 `Announcements` |
| **特性** | 勾选 `启用懒加载` |

页面下方会自动生成脚本，其中关键两行：

```html
data-repo-id="R_kgDONxxxxx"          ← 复制这个
data-category-id="DIC_kwDONxxxxx"    ← 复制这个
```

### 第 3 步：填入 `index.html`

打开 [index.html](./index.html) 第 1698 行附近，替换 `GISCUS_CONFIG`：

```js
// 修改前
const GISCUS_CONFIG = {
  repo: 'shungxin/stellar-comments',
  repoId: 'R_kgDONxxxxx',         // ← 替换
  category: 'General',
  categoryId: 'DIC_kwDONxxxxx',   // ← 替换
  theme: 'noborder_dark',
  lang: 'zh-CN',
};

// 修改后（示例）
const GISCUS_CONFIG = {
  repo: 'shungxin/shungxin.github.io',  // 或你的仓库
  repoId: 'R_kgDOAbc123def',            // ← 填入真实 repo-id
  category: 'General',
  categoryId: 'DIC_kwDOAbc123def',      // ← 填入真实 category-id
  theme: 'noborder_dark',
  lang: 'zh-CN',
};
```

### 第 4 步：填入 `comments.html` 同样的配置

打开 [comments.html](./comments.html) 第 380 行附近，替换 `GISCUS_CONFIG` 的 `repoId` 和 `categoryId`：

```js
const GISCUS_CONFIG = {
  repo: 'shungxin/shungxin.github.io',
  repoId: 'R_kgDOAbc123def',            // ← 填入（与 index.html 相同）
  category: 'General',
  categoryId: 'DIC_kwDOAbc123def',      // ← 填入
  // ...
};
```

### 第 5 步：部署

```bash
git add index.html comments.html
git commit -m "feat(comments): enable giscus real mode"
git push
```

## 二级域名部署（CNAME）

**复用 shungxin.github.io 仓库**的方案下，子域名配置最简单的是 **Cloudflare 转发**：

### 方案 A：DNS 转发（推荐）

1. 在 Cloudflare 添加站点 `comments.shungxin.com`
2. DNS → 添加 `comments` CNAME 记录指向 `shungxin.github.io`
3. Rules → Redirect Rules → `comments.shungxin.com/*` 301 跳转到 `https://shungxin.github.io/comments/?*`

### 方案 B：GitHub Pages 多站点（需要独立仓库）

由于 `shungxin.github.io` 仓库是用户主页站点，**无法** 通过它的 GitHub Pages 同时托管 `/comments/` 子路径（但可通过项目仓库实现）。

如果您有 `stellar-comments` 独立仓库：

```bash
# 独立仓库目录结构
stellar-comments/
├── index.html    # 由 comments.html 改名得到
├── CNAME         # 写入 comments.shungxin.com
└── README.md
```

仓库 Settings → Pages → Custom domain: `comments.shungxin.com`

## 验证升级成功

部署后打开主站 `https://shungxin.github.io`：

1. **F12 打开控制台**，应看到：
   ```
   Stellar Comments 配置检查器
   Giscus 已配置：✅ 是
   仓库：shungxin/shungxin.github.io
   repo-id：R_kgDOAbc123def
   ```

2. **点击任意评论按钮**，抽屉内应直接显示 Giscus iframe 评论区，可登录 GitHub 账号发布真实评论

3. **打开子站** `https://comments.shungxin.com/?thread=site`，应显示完整的 Giscus 嵌入评论区

## 高级：自定义 Giscus 主题

当前使用 `noborder_dark` 主题。如果想完全匹配 Stellar 暗色金色风格，可在 [giscus.app 主题生成器](https://giscus.app/zh-CN) 调整：

| 颜色项 | 推荐值 |
|---|---|
| 主色 | `#D4A853` (Stellar 金色) |
| 主色（亮） | `#F0D48A` (金色高光) |
| 文字色 | `#F0F0F5` (Stellar 灰白) |
| 背景色 | `#111118` (Stellar 卡片) |
| 边框 | `#252530` (Stellar 边框) |

把生成的 `data-theme="..."` 替换为自定义 URL，填入 `theme` 字段：

```js
theme: 'https://giscus.app/themes/custom/example.css',
```

## FAQ

**Q: 升级后是否还能用之前的演示模式？**
A: 仍可！打开 `comments.html?demo=1` 即可强制启用本地存储演示模式。

**Q: Giscus 评论会同步到主站抽屉吗？**
A: 会。Giscus iframe 通过 `postMessage` 自动通知主站评论数变化，角标实时更新。

**Q: 用户在主站发布评论的体验如何？**
A: 在抽屉内直接点击 Giscus 顶部输入框 → 弹窗登录 GitHub → 输入评论 → 发布。所有操作无需离开主站。

**Q: 二级域名 `comments.shungxin.com` 必须部署吗？**
A: 不必须。主站 `index.html` 已直接嵌入 Giscus，**子站 `comments.html` 是可选的独立展示页**。

**Q: 旧演示模式的 localStorage 评论会丢失吗？**
A: 不会丢失，但只在演示模式（`?demo=1`）下可见。一旦启用 Giscus，建议清空 localStorage 中 `stellar_comments_*` 开头的 key 释放空间。

## 完成检查清单

- [ ] 仓库 Discussions 已启用
- [ ] giscus.app 取得 `repo-id` 和 `category-id`
- [ ] `index.html` 顶部 `GISCUS_CONFIG.repoId` 已替换
- [ ] `index.html` 顶部 `GISCUS_CONFIG.categoryId` 已替换
- [ ] `comments.html` 顶部 `GISCUS_CONFIG.repoId` 已替换
- [ ] `comments.html` 顶部 `GISCUS_CONFIG.categoryId` 已替换
- [ ] 代码已推送到 GitHub
- [ ] 主站打开评论抽屉，能看到真实 Giscus iframe
- [ ] 能用 GitHub 账号登录并发布评论
- [ ] （可选）CNAME 已配置 `comments.shungxin.com`
