# Stellar 评论系统部署指南

## 架构总览

```
┌────────────────────────────────────────────────────────────┐
│  主站 (shungxin.github.io)                                  │
│  index.html — Stellar 画廊                                  │
│                                                              │
│  ┌──────────────┐  点击评论  ┌────────────────────┐        │
│  │ 卡片 / Lightbox │ ─────→ │ 右滑抽屉 (UI)         │        │
│  └──────────────┘         │  fetch() 子站 API    │        │
│                            │  渲染评论列表         │        │
│                            │  发送评论 → 新窗口   │        │
│                            └─────────┬──────────┘         │
└──────────────────────────────────────┼──────────────────────┘
                                       │ window.open
                                       ▼
┌────────────────────────────────────────────────────────────┐
│  comments 子站 (comments.shungxin.github.io)                │
│  comments.html — 评论服务                                   │
│                                                              │
│  - URL 参数接收 thread / draft                              │
│  - Giscus iframe (可选) → 真实发布到 GitHub Discussions    │
│  - 本地 localStorage 兜底存储                               │
│  - postMessage(opener) → 实时回传到主站                     │
└────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                            GitHub Discussions
                          (shungxin/stellar-comments)
```

## 当前状态

- ✅ **本地演示模式**已可用：评论保存在浏览器 localStorage，跨域通过 `postMessage` 实时同步到主站抽屉
- ⏳ **Giscus 真发布**需配置后启用（见下方步骤）

## 文件说明

| 文件 | 位置 | 作用 |
|---|---|---|
| 主站 | `index.html` | 添加了：评论抽屉 UI、卡片角标、Lightbox 评论按钮、跨域消息接收 |
| 子站 | `comments.html` | 新增的独立评论页：发布表单、评论列表、Giscus 集成、postMessage 回传 |

## 部署到二级域名

### 方案 A：GitHub Pages 子路径（最简单）

1. **创建评论仓库**
   ```bash
   # 在 GitHub 上新建公开仓库: shungxin/stellar-comments
   # 在仓库 Settings → General → Features 勾选 Discussions
   ```

2. **推送 comments.html**
   ```bash
   cd stellar-comments
   cp ../html/comments.html ./index.html
   git add . && git commit -m "init: stellar comments subdomain"
   git push origin main
   ```

3. **启用 GitHub Pages**
   - 仓库 Settings → Pages → Source: `main` 分支根目录
   - 等待 1-2 分钟，访问 `https://shungxin.github.io/stellar-comments/`

4. **修改主站配置**
   - 打开 `index.html`
   - 找到 `const COMMENTS_BASE = 'https://shungxin.github.io'`
   - 改为 `const COMMENTS_BASE = 'https://shungxin.github.io/stellar-comments'`

### 方案 B：自定义二级域名（推荐）

1. **配置 DNS**
   ```
   # 在域名服务商添加 CNAME 记录
   comments.shungxin.com → shungxin.github.io.
   ```

2. **创建独立仓库**
   - 新建 `shungxin.github.io.comments`（或 `shungxin-comments`）
   - 推送 `comments.html` 为 `index.html`
   - Settings → Pages → Custom domain: `comments.shungxin.com`
   - 勾选 Enforce HTTPS

3. **修改主站配置**
   ```js
   const COMMENTS_BASE = 'https://comments.shungxin.com';
   ```

## 启用真实 Giscus 发布

1. **访问配置生成器**
   - 打开 https://giscus.app/zh-CN

2. **填入仓库信息**
   - 仓库：`shungxin/stellar-comments`（或你的实际仓库）
   - 页面 ↔ Discussion 映射关系：**`specific term`**
   - Discussion 分类：**`General`**

3. **复制配置**
   - 页面下方会显示 `data-repo-id` 和 `data-category-id`
   - 形如 `R_xxx` 和 `DIC_xxx`

4. **填入 comments.html**
   ```js
   // 在文件顶部 ~ 第 405 行附近
   const GISCUS_REPO_ID = 'R_xxxxxxxxx';           // 替换为你的 repo-id
   const GISCUS_CATEGORY = 'General';
   const GISCUS_CATEGORY_ID = 'DIC_xxxxxxxxx';     // 替换为你的 category-id
   const GISCUS_ENABLED = true;                    // 启用！
   ```

5. **测试**
   - 主站点击任意评论按钮
   - 子站新窗口打开，应能看到 Giscus 评论区
   - 在 Giscus 内登录 GitHub → 发布评论
   - 主站抽屉应实时收到新评论

## 评论 Thread 映射策略

主站每张图片对应一个独立 thread：

| 主站 | 子站 thread 参数 | GitHub Discussion 标识 |
|---|---|---|
| 整站讨论 | `thread=site` | term: `site` |
| 图片 1 | `thread=image-1` | term: `image-1` |
| 图片 2 | `thread=image-2` | term: `image-2` |
| ... | `thread=image-{id}` | term: `image-{id}` |

由于使用了 `data-mapping="specific"` + `data-term={thread}`，Giscus 会自动按 thread 创建独立的 Discussion。

## URL 参数协议

主站打开子站时构造的 URL：

```
https://comments.shungxin.com/
  ?thread=image-5              # 必填：thread 标识
  &title=人像作品 05           # 可选：页面标题
  &draft=今晚的星空好美        # 可选：草稿内容（自动填入输入框）
  &return=https://...#comments-image-5  # 可选：发布后跳转
```

## postMessage 协议

**子站 → 主站**（opener）：
```js
window.opener.postMessage({
  type: 'stellar:comment-posted',
  thread: 'image-5',
  comment: {
    id: 'cmt-xxx',
    author: 'octocat',
    avatar: 'https://avatars.githubusercontent.com/...',
    content: '评论内容',
    ts: 1719251234567,
    from: 'GitHub Discussions',  // 来源标识
  },
}, 'https://shungxin.github.io');
```

**主站 → 子站**（如需反向通知）：目前未使用，预留扩展。

## 安全考虑

| 风险 | 缓解措施 |
|---|---|
| XSS 注入 | `escapeHtml()` 转义所有用户内容；`https?://` URL 正则限制自动链接 |
| postMessage 伪造 | `e.origin` 白名单校验（仅接受 Giscus 官方域） |
| 弹窗拦截 | `window.open` 失败时降级为当前窗口跳转 |
| CORS 拉取失败 | localStorage 兜底存储，UI 始终有内容可显示 |
| Spam 攻击 | Giscus 自带 hCaptcha 反垃圾 |

## 调试技巧

```js
// 在主站控制台
StellarComments.state                 // 查看当前 thread 状态
StellarComments.showCommentsFor('image-1', '测试', 'debug')  // 手动打开评论

// 在子站控制台
StellarCommentsSub.getThread('image-1')  // 读取某 thread 的本地评论
```

## FAQ

**Q: 评论会丢失吗？**
A: 演示模式下保存在浏览器 localStorage，清缓存会丢失。启用 Giscus 后永久保存在 GitHub。

**Q: 评论是否需要登录？**
A: 演示模式不需要。启用 Giscus 后需要登录 GitHub 账号（与评论博客的常见做法一致）。

**Q: 评论数据能否迁移？**
A: 启用 Giscus 后可使用 `giscus` CLI 工具从 localStorage 批量迁移到 GitHub Discussions。

**Q: 二级域名必须独立吗？**
A: 不必须，也可以用子路径（如 `/comments/`）。区别仅在于 DNS 与 SEO，独立子域名看起来更专业。
