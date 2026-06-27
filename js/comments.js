
    (function() {
      'use strict';

      // === Giscus 配置（单一来源: window.AppConfig.GISCUS） ===
      // 优先从 config.js 读取, 老的硬编码值作为 fallback
      const GISCUS_CONFIG = Object.assign({
        repo: '1289107388/shungxin.github.io',
        repoId: 'R_kgDOTCxZGQ',
        category: 'General',
        categoryId: 'DIC_kwDOTCxZGc4C_xSE',
        theme: 'noborder_dark',
        lang: 'zh-CN',
      }, (window.AppConfig && window.AppConfig.GISCUS) || {});

      // === 二级域名配置（子站独立页） ===
      const COMMENTS_BASE = 'https://1289107388.github.io/stellar-comments';

      // === 状态 ===
      const state = {
        currentThread: 'site',
        currentTitle: '整站讨论',
        currentSubtitle: 'GitHub Discussions · 真实模式',
      };

      // === 工具函数 ===
      function isAbortError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        const msg = String(err.message || err).toLowerCase();
        return msg.includes('aborted') || msg.includes('abort') || msg.includes('cancel');
      }

      // === 检测是否已配置 ===
      const isConfigured =
        GISCUS_CONFIG.repoId && !GISCUS_CONFIG.repoId.includes('xxxxx') &&
        GISCUS_CONFIG.categoryId && !GISCUS_CONFIG.categoryId.includes('xxxxx');

      // === 抽屉控制 ===
      const overlay = document.getElementById('commentsOverlay');
      const closeBtn = document.getElementById('commentsDrawerClose');
      const titleEl = document.getElementById('commentsDrawerTitle');
      const subtitleEl = document.getElementById('commentsDrawerSubtitle');
      const body = document.getElementById('commentsDrawerBody');
      const openSubdomainBtn = document.getElementById('openSubdomain');

      function openDrawer() {
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
      function closeDrawer() {
        overlay.classList.remove('open');
        document.body.style.overflow = '';
      }
      closeBtn.addEventListener('click', () => {
        if (activeReplyParentId != null) hideReplyForm(activeReplyParentId);
        closeDrawer();
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          if (activeReplyParentId != null) hideReplyForm(activeReplyParentId);
          closeDrawer();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
          if (activeReplyParentId != null) hideReplyForm(activeReplyParentId);
          closeDrawer();
        }
      });

      // === 在子域名独立页打开 ===
      openSubdomainBtn.addEventListener('click', () => {
        const url = COMMENTS_BASE
          + '/?thread=' + encodeURIComponent(state.currentThread)
          + '&title=' + encodeURIComponent(state.currentTitle);
        window.open(url, '_blank', 'noopener,noreferrer');
      });

      // === Lightbox 工具栏评论数同步 ===
      // 直接更新 DOM 元素（不做网络请求）
      function updateLightboxCommentCount(count) {
        const el = document.getElementById('lightboxCommentCount');
        if (el) {
          const safe = (typeof count === 'number' && !isNaN(count) && count >= 0) ? count : 0;
          el.textContent = safe > 99 ? '99+' : safe;
        }
      }

      // 拉取并刷新 lightbox 工具栏的评论数：优先使用缓存
      async function refreshLightboxCommentCount(imageId) {
        if (!imageId) { updateLightboxCommentCount(0); return; }

        // 1) 命中缓存
        if (window.commentCountsData &&
            Object.prototype.hasOwnProperty.call(window.commentCountsData, String(imageId))) {
          updateLightboxCommentCount(window.commentCountsData[String(imageId)]);
        }

        // 2) 拉取最新数据（异步），不阻塞 UI
        try {
          if (!window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.url) return;
          const resp = await fetch(
            window.SUPABASE_CONFIG.url + '/functions/v1/comment-api/list?image_id=' + imageId + '&page=1&limit=1&sort=newest',
            {
              headers: {
                'apikey': window.SUPABASE_CONFIG.anonKey,
                'Authorization': 'Bearer ' + window.SUPABASE_CONFIG.anonKey
              }
            }
          );
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = await resp.json();
          const total = (data.pagination && typeof data.pagination.total === 'number')
            ? data.pagination.total
            : 0;
          if (window.commentCountsData) {
            window.commentCountsData[String(imageId)] = total;
          }
          // 仅在 lightbox 仍展示同一张图时才更新，避免快速翻页造成的闪烁
          if (window.currentLightboxImageId === imageId) {
            updateLightboxCommentCount(total);
          }
        } catch (e) {
          if (!isAbortError(e)) console.warn('刷新 lightbox 评论数失败:', e.message);
          // 失败时不要覆盖显示 0，避免把已有评论的图片误显示为 0
        }
      }

      // 暴露到 window，供其他 IIFE 内的代码调用
      window.updateLightboxCommentCount = updateLightboxCommentCount;
      window.refreshLightboxCommentCount = refreshLightboxCommentCount;

      // === 自建评论系统：从 Supabase 加载 ===
      // 调试开关：本地调试可设为 true，生产环境保持 false
      window.__commentApiDebug = false;
      let currentCommentsPage = 1;
      let currentCommentsSort = 'newest';
      let currentImageId = null;
      // 修复: 每次 loadCommentsFor 启动时自增,响应回来时校验 seq,
      // 防止"图 A 的响应晚于图 B 到达"时把 B 的评论区覆盖成 A 的内容
      let commentsReqSeq = 0;
      // 已加载的子评论缓存：{ parentId: { items: [], loadedAt: number, expanded: bool } }
      const replyCache = {};
      // 正在打开回复表单的父评论 id（同一时刻只允许一个）
      let activeReplyParentId = null;
      // 提交回复时的 parent_id 缓存
      let pendingReplyTarget = null; // { parentId, replyToUsername }

      // 取出当前用户标识：登录用户 -> 访客
      // 优先使用 utils.js 统一实现, 保证各模块生成的 ID 一致
      function ensureVisitorId() {
        if (window.Utils && typeof window.Utils.getVisitorId === 'function') {
          return window.Utils.getVisitorId();
        }
        let id = localStorage.getItem('visitor_id');
        if (!id) {
          id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
          localStorage.setItem('visitor_id', id);
        }
        return id;
      }
      function getCurrentUserId() {
        try {
          const auth = window.auth;
          if (auth && auth.isLoggedIn && auth.isLoggedIn()) {
            const u = auth.getUser();
            if (u && u.id) return 'user_' + u.id;
          }
        } catch (e) {}
        return 'visitor_' + ensureVisitorId();
      }

      function getCurrentDisplayName() {
        try {
          const auth = window.auth;
          if (auth && auth.isLoggedIn && auth.isLoggedIn()) {
            const u = auth.getUser();
            if (u) return u.display_name || u.username || '用户';
          }
        } catch (e) {}
        const vid = ensureVisitorId().slice(-4) || Math.floor(Math.random() * 9000 + 1000);
        return '访客' + vid;
      }

      // 通用 fetch 包装：调用 comment-api
      async function callCommentApi(path, init) {
        const url = window.SUPABASE_CONFIG.url + '/functions/v1/comment-api/' + path;
        // 构建 headers: apikey 始终传; Authorization 优先用用户 token,未登录则用 anonKey
        const headers = {
          'apikey': window.SUPABASE_CONFIG.anonKey,
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + window.SUPABASE_CONFIG.anonKey,
        };
        const userToken = localStorage.getItem('shungxin_auth_token');
        if (userToken) {
          headers['Authorization'] = 'Bearer ' + userToken;
        }
        const opts = Object.assign({
          headers,
        }, init || {});
        // 如果 init 里也传了 headers,合并一下(init 的优先级更高)
        if (init && init.headers) {
          opts.headers = Object.assign({}, headers, init.headers);
        }

        // 调试：记录请求 payload（仅在 window.__commentApiDebug === true 时）
        if (window.__commentApiDebug && opts.body) {
          try { console.log('[comment-api] →', path, JSON.parse(opts.body)); } catch (e) {}
        }
        const resp = await fetch(url, opts);
        // 调试：记录响应
        if (window.__commentApiDebug) {
          try {
            const clone = resp.clone();
            clone.json().then(j => console.log('[comment-api] ←', path, resp.status, j)).catch(() => console.log('[comment-api] ←', path, resp.status, '<no json>'));
          } catch (e) {}
        }
        return resp;
      }

      async function loadCommentsFor(imageId, page = 1, sort = 'newest') {
        currentImageId = imageId;
        currentCommentsPage = page;
        currentCommentsSort = sort;

        // 同步更新评论框登录提示
        const authHint = document.getElementById('composerAuthHint');
        if (authHint) {
          const loggedIn = window.auth && window.auth.isLoggedIn && window.auth.isLoggedIn();
          authHint.hidden = !!loggedIn;
        }

        body.innerHTML = '<div class="comments-loading"><div class="comments-loading-spinner"></div>正在加载评论…</div>';

        // 修复: 抢占一个请求序列号;await 后如果已被新请求抢占就直接 return
        const myReqId = ++commentsReqSeq;

        try {
          const userId = getCurrentUserId();
          const resp = await callCommentApi(
            'list?image_id=' + imageId + '&page=' + page + '&limit=20&sort=' + sort + '&user_id=' + encodeURIComponent(userId)
          );
          // 响应到达时校验: 已经有更新的请求,本响应过期,直接丢弃
          if (myReqId !== commentsReqSeq) return;
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = await resp.json();
          if (myReqId !== commentsReqSeq) return;
          if (!data.success) throw new Error(data.error || '加载失败');

          const total = (data.pagination && typeof data.pagination.total === 'number')
            ? data.pagination.total
            : (data.data?.length || 0);

          if (window.commentCountsData) {
            // 统一使用字符串 key, 避免数字/字符串类型不匹配
            window.commentCountsData[String(imageId)] = total;
          }

          renderComments(data.data || [], data.pagination);
          updateCommentsCountBadge(total);

          if (typeof updateLightboxCommentCount === 'function' &&
              window.currentLightboxImageId === imageId) {
            updateLightboxCommentCount(total);
          }

          // P1 阶段 C-1: 广播评论数变化(老代码用 typeof 检测函数存在, 保留兼容)
          try {
            window.EventBus && window.EventBus.emit('comment:update', {
              imageId: imageId,
              total: total,
              source: 'load',
            });
          } catch (_) { /* ignore */ }
        } catch (e) {
          // 过期请求或主动取消的失败不显示,避免闪烁
          if (myReqId !== commentsReqSeq || isAbortError(e)) return;
          console.warn('加载评论失败:', e.message);
          body.innerHTML = '<div class="comments-empty"><div class="comments-empty-icon">💬</div><div class="comments-empty-title">暂无评论</div><div class="comments-empty-desc">成为第一个评论的人吧！</div></div>';
          // 修复: 失败时不要抹零已有评论数,只在该 imageId 还没缓存时才记 0
          if (window.commentCountsData &&
              !Object.prototype.hasOwnProperty.call(window.commentCountsData, String(imageId))) {
            window.commentCountsData[String(imageId)] = 0;
          }
          if (typeof updateLightboxCommentCount === 'function' &&
              window.currentLightboxImageId === imageId) {
            updateLightboxCommentCount(0);
          }
        }
      }

      // 优先使用 utils.js 中的统一实现, 没有则 fallback 到本地
      function escapeHtml(text) {
        if (window.Utils && typeof window.Utils.escapeHtml === 'function') {
          return window.Utils.escapeHtml(text);
        }
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
      }

      // 把 ISO 时间渲染成"刚刚 / x 分钟前 / x 小时前 / x 天前 / 具体日期"
      // 优先使用 utils.js 中的统一实现, 没有则 fallback 到本地
      function formatRelativeTime(iso) {
        if (window.Utils && typeof window.Utils.formatRelativeTime === 'function') {
          return window.Utils.formatRelativeTime(iso);
        }
        if (!iso) return '';
        const ts = new Date(iso).getTime();
        if (isNaN(ts)) return '';
        const diff = Date.now() - ts;
        if (diff < 0) return '刚刚';
        const m = Math.floor(diff / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' 小时前';
        const d = Math.floor(h / 24);
        if (d < 7) return d + ' 天前';
        return new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }

      function buildAvatarHtml(c) {
        const username = c.github_username || '匿名用户';
        const seed = username.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '') || 'anon';
        const colors = ['#d4a853', '#5b8cba', '#9b6bb5', '#5cb88a', '#c75c5c', '#d4884d', '#6c8eb8', '#a05c9b'];
        let colorIdx = 0;
        for (let i = 0; i < seed.length; i++) colorIdx = (colorIdx + seed.charCodeAt(i)) % colors.length;
        const avatarColor = colors[colorIdx];
        const initial = username.charAt(0).toUpperCase();
        if (c.github_avatar) {
          // 用 data 属性存储 fallback 信息, 避免内联 onerror 的转义风险
          return '<img class="comment-avatar-img" src="' + escapeHtml(c.github_avatar) + '" alt=""' +
                 ' data-avatar-username="' + escapeHtml(username) + '"' +
                 ' data-avatar-color="' + avatarColor + '"' +
                 ' data-avatar-initial="' + escapeHtml(initial) + '">';
        }
        return buildInitialAvatarHtml(username, avatarColor, initial);
      }
      function buildInitialAvatarHtml(username, color, initial) {
        return '<div class="comment-avatar" style="background:' + color + ';">' + escapeHtml(initial) + '</div>';
      }

      // 渲染单条评论的 HTML（顶级评论 / 回复通用）
      function renderCommentItem(c, isReply) {
        const username = c.github_username || '匿名用户';
        const time = formatRelativeTime(c.created_at);
        const liked = !!c.liked_by_me;
        const likeCount = c.likes_count || 0;
        const rating = c.rating ? '★ ' + c.rating : '';
        const replyTo = c.reply_to_username && !isReply
          ? '<span class="comment-reply-to">回复 <em>@' + escapeHtml(c.reply_to_username) + '</em></span>'
          : '';
        const replyCount = !isReply ? (c.replies_count || 0) : 0;

        const actionRow =
          '<div class="comment-actions">' +
            '<button class="comment-action-btn comment-like-btn' + (liked ? ' liked' : '') + '" data-comment-id="' + c.id + '" data-liked="' + (liked ? '1' : '0') + '" title="点赞">' +
              '<svg class="icon-heart" viewBox="0 0 24 24" fill="' + (liked ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>' +
              '<span class="comment-like-count">' + likeCount + '</span>' +
            '</button>' +
            '<button class="comment-action-btn comment-reply-btn" data-comment-id="' + c.id + '" data-image-id="' + (c.image_id || currentImageId || 0) + '" data-username="' + escapeHtml(username) + '" title="回复">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>' +
              '<span>回复</span>' +
            '</button>' +
          '</div>';

        let repliesBlock = '';
        if (!isReply) {
          // 顶级评论：渲染回复列表容器 + 切换按钮 + 回复表单容器
          repliesBlock =
            '<div class="comment-replies" data-parent-id="' + c.id + '">' +
              '<div class="comment-replies-list" id="repliesList-' + c.id + '"></div>' +
              (replyCount > 0
                ? '<button class="comment-replies-toggle" data-parent-id="' + c.id + '" data-action="show">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
                    '<span>查看 ' + replyCount + ' 条回复</span>' +
                  '</button>'
                : '<button class="comment-replies-toggle comment-replies-toggle--always" data-parent-id="' + c.id + '" data-action="show" style="display:none"></button>') +
              '<div class="comment-reply-form-wrap" id="replyFormWrap-' + c.id + '" style="display:none;"></div>' +
            '</div>';
        } else {
          // 子回复：也渲染一个独立表单容器，让"对子回复再回复"也能用
          // 放在 comment-item 末尾（用 inline-block 容器，与上级回复缩进对齐）
          repliesBlock =
            '<div class="comment-reply-form-wrap" id="replyFormWrap-' + c.id + '" style="display:none;"></div>';
        }

        return (
          '<div class="comment-item' + (isReply ? ' comment-item--reply' : '') + '" data-comment-id="' + c.id + '">' +
            '<div class="comment-item-row">' +
              buildAvatarHtml(c) +
              '<div class="comment-body">' +
                '<div class="comment-meta">' +
                  '<span class="comment-author">' + escapeHtml(username) + '</span>' +
                  '<span class="comment-time">' + time + '</span>' +
                  (rating ? '<span class="comment-rating">' + rating + '</span>' : '') +
                  replyTo +
                '</div>' +
                '<div class="comment-content">' + escapeHtml(c.content) + '</div>' +
                actionRow +
              '</div>' +
            '</div>' +
            repliesBlock +
          '</div>'
        );
      }

      function renderComments(comments, pagination) {
        if (!comments.length) {
          body.innerHTML = '<div class="comments-empty"><div class="comments-empty-icon">💬</div><div class="comments-empty-title">暂无评论</div><div class="comments-empty-desc">成为第一个评论的人吧！</div></div>';
          return;
        }

        // 重置子评论缓存
        for (const k in replyCache) delete replyCache[k];

        let html = '<div class="comments-list">';
        comments.forEach(c => { html += renderCommentItem(c, false); });
        html += '</div>';

        if (pagination && pagination.hasMore) {
          html += '<div class="comments-loadmore">' +
            '<button id="loadMoreComments">加载更多</button>' +
          '</div>';
        }

        body.innerHTML = html;

        // 绑定加载更多
        const loadMoreBtn = document.getElementById('loadMoreComments');
        if (loadMoreBtn) {
          loadMoreBtn.addEventListener('click', () => {
            loadCommentsFor(currentImageId, currentCommentsPage + 1, currentCommentsSort);
          });
        }

        bindCommentActions();
      }

      // 绑定所有评论/回复上的动作按钮（点赞、回复、查看回复）
      function bindCommentActions() {
        // 头像图片加载失败时回退到文字头像
        body.querySelectorAll('.comment-avatar-img').forEach((img) => {
          if (img.dataset.bound) return;
          img.dataset.bound = '1';
          img.addEventListener('error', () => {
            const username = img.dataset.avatarUsername || '?';
            const color = img.dataset.avatarColor || '#999';
            const initial = img.dataset.avatarInitial || username.charAt(0).toUpperCase();
            const div = document.createElement('div');
            div.className = 'comment-avatar';
            div.style.background = color;
            div.textContent = initial;
            img.outerHTML = div.outerHTML;
          });
        });

        // 点赞
        body.querySelectorAll('.comment-like-btn').forEach((btn) => {
          if (btn.dataset.bound) return;
          btn.dataset.bound = '1';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleCommentLike(btn);
          });
        });
        // 回复按钮
        body.querySelectorAll('.comment-reply-btn').forEach((btn) => {
          if (btn.dataset.bound) return;
          btn.dataset.bound = '1';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const parentId = parseInt(btn.dataset.commentId, 10);
            const replyTo = btn.dataset.username || '';
            // 锁定 imageId：防止闭包读到过时的 currentImageId
            const imageId = parseInt(btn.dataset.imageId, 10) || currentImageId;
            showReplyForm(parentId, replyTo, imageId);
          });
        });
        // 展开/收起回复
        body.querySelectorAll('.comment-replies-toggle').forEach((btn) => {
          if (btn.dataset.bound) return;
          btn.dataset.bound = '1';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const parentId = parseInt(btn.dataset.parentId, 10);
            toggleReplies(parentId);
          });
        });
      }

      async function handleCommentLike(btn) {
        const commentId = parseInt(btn.dataset.commentId, 10);
        if (!commentId) return;
        const liked = btn.dataset.liked === '1';
        const nextAction = liked ? 'unlike' : 'like';
        const userId = getCurrentUserId();
        const countEl = btn.querySelector('.comment-like-count');
        const iconEl  = btn.querySelector('.icon-heart');

        // 乐观更新
        if (liked) {
          btn.classList.remove('liked');
          btn.dataset.liked = '0';
          if (countEl) countEl.textContent = Math.max(0, (parseInt(countEl.textContent, 10) || 1) - 1);
          if (iconEl) iconEl.setAttribute('fill', 'none');
        } else {
          btn.classList.add('liked');
          btn.dataset.liked = '1';
          if (countEl) countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + 1;
          if (iconEl) iconEl.setAttribute('fill', 'currentColor');
        }
        btn.disabled = true;

        try {
          const resp = await callCommentApi('like-toggle', {
            method: 'POST',
            body: JSON.stringify({ comment_id: commentId, action: nextAction, user_id: userId }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.success === false) {
            throw new Error(data.error || 'HTTP ' + resp.status);
          }
          // 用服务端返回的真实数量校正
          if (countEl && typeof data.data?.count === 'number') countEl.textContent = data.data.count;
        } catch (err) {
          if (isAbortError(err)) {
            btn.disabled = false;
            return;
          }
          console.warn('评论点赞失败:', err);
          // 回滚乐观更新
          if (liked) {
            btn.classList.add('liked');
            btn.dataset.liked = '1';
            if (countEl) countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + 1;
            if (iconEl) iconEl.setAttribute('fill', 'currentColor');
          } else {
            btn.classList.remove('liked');
            btn.dataset.liked = '0';
            if (countEl) countEl.textContent = Math.max(0, (parseInt(countEl.textContent, 10) || 1) - 1);
            if (iconEl) iconEl.setAttribute('fill', 'none');
          }
          showToast('点赞失败：' + (err.message || '网络错误'));
        } finally {
          btn.disabled = false;
        }
      }

      // 展开 / 收起某条顶级评论的子回复
      async function toggleReplies(parentId) {
        const cache = replyCache[parentId];
        const listEl = document.getElementById('repliesList-' + parentId);
        const toggleBtn = body.querySelector('.comment-replies-toggle[data-parent-id="' + parentId + '"]');
        if (!listEl) return;

        if (cache && cache.expanded) {
          // 收起
          cache.expanded = false;
          listEl.innerHTML = '';
          if (toggleBtn) {
            toggleBtn.dataset.action = 'show';
            toggleBtn.innerHTML =
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
              '<span>查看 ' + (cache.items.length || (cache.lastCount || 0)) + ' 条回复</span>';
          }
          return;
        }

        // 展开：优先用缓存，否则请求
        if (!cache) {
          listEl.innerHTML = '<div class="comment-reply-loading">正在加载回复…</div>';
          try {
            const userId = getCurrentUserId();
            const resp = await callCommentApi('replies?parent_id=' + parentId + '&user_id=' + encodeURIComponent(userId));
            const data = await resp.json();
            if (!resp.ok || !data.success) throw new Error(data.error || '加载回复失败');
            const items = data.data || [];
            replyCache[parentId] = { items, expanded: true, lastCount: items.length };
            renderReplyList(parentId, items);
          } catch (e) {
            if (isAbortError(e)) {
              listEl.innerHTML = '';
            } else {
              listEl.innerHTML = '<div class="comment-reply-empty">回复加载失败</div>';
              console.warn(e);
            }
          }
        } else {
          cache.expanded = true;
          renderReplyList(parentId, cache.items);
        }
      }

      function renderReplyList(parentId, items) {
        const listEl = document.getElementById('repliesList-' + parentId);
        const toggleBtn = body.querySelector('.comment-replies-toggle[data-parent-id="' + parentId + '"]');
        if (!listEl) return;
        if (!items.length) {
          listEl.innerHTML = '<div class="comment-reply-empty">还没有回复</div>';
          if (toggleBtn) toggleBtn.style.display = 'none';
          return;
        }
        listEl.innerHTML = items.map((r) => renderCommentItem(r, true)).join('');
        // 重新绑定回复内的点赞/回复按钮
        listEl.querySelectorAll('.comment-like-btn').forEach((btn) => {
          btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleCommentLike(btn); });
        });
        listEl.querySelectorAll('.comment-reply-btn').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const parentId2 = parseInt(btn.dataset.commentId, 10);
            const imageId2 = parseInt(btn.dataset.imageId, 10) || currentImageId;
            showReplyForm(parentId2, btn.dataset.username || '', imageId2);
          });
        });
        if (toggleBtn) {
          toggleBtn.dataset.action = 'hide';
          toggleBtn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>' +
            '<span>收起回复</span>';
        }
      }

      // 显示回复表单（行内）
      function showReplyForm(parentId, replyToUsername, imageId) {
        // 防止点击的是已经过时的 DOM（切图后 fetch 还没返回）
        if (imageId && currentImageId && imageId !== currentImageId) {
          showToast('请等待评论加载完成后再回复');
          return;
        }
        // 同一时刻只允许一个回复表单：先收起其它的
        if (activeReplyParentId && activeReplyParentId !== parentId) {
          hideReplyForm(activeReplyParentId);
        }
        const wrap = document.getElementById('replyFormWrap-' + parentId);
        if (!wrap) {
          console.warn('showReplyForm: 找不到 replyFormWrap-' + parentId + '，无法弹出回复表单。可能这条评论已被刷新。');
          showToast('回复表单初始化失败，请刷新抽屉重试');
          return;
        }
        if (activeReplyParentId === parentId && wrap.style.display !== 'none') {
          // 再次点击 = 收起
          hideReplyForm(parentId);
          return;
        }
        activeReplyParentId = parentId;
        // 锁定 imageId：与 currentImageId 一致，确保 submitReply 期间不会因切图而发送到错误的图片
        pendingReplyTarget = { parentId, replyToUsername, imageId: imageId || currentImageId };
        wrap.innerHTML =
          '<div class="reply-form">' +
            '<div class="reply-form-tip">回复 <em>@' + escapeHtml(replyToUsername) + '</em></div>' +
            '<textarea class="reply-form-input" id="replyInput-' + parentId + '" maxlength="1000" rows="2" placeholder="写下你的回复…"></textarea>' +
            '<div class="reply-form-actions">' +
              '<button type="button" class="reply-form-cancel" data-parent-id="' + parentId + '">取消</button>' +
              '<button type="button" class="reply-form-send" data-parent-id="' + parentId + '">发送</button>' +
            '</div>' +
          '</div>';
        wrap.style.display = '';
        const input = document.getElementById('replyInput-' + parentId);
        if (input) { input.focus(); }

        wrap.querySelector('.reply-form-cancel').addEventListener('click', () => hideReplyForm(parentId));
        wrap.querySelector('.reply-form-send').addEventListener('click', () => submitReply(parentId, replyToUsername, pendingReplyTarget.imageId));
        if (input) {
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submitReply(parentId, replyToUsername, pendingReplyTarget.imageId);
            } else if (e.key === 'Escape') {
              hideReplyForm(parentId);
            }
          });
        }
      }

      function hideReplyForm(parentId) {
        const wrap = document.getElementById('replyFormWrap-' + parentId);
        if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
        if (activeReplyParentId === parentId) {
          activeReplyParentId = null;
          pendingReplyTarget = null;
        }
      }

      // 提交回复
      async function submitReply(parentId, replyToUsername, lockedImageId) {
        // 锁定 imageId 优先：避免切图后 currentImageId 已变但回复还在用旧值
        const imageId = lockedImageId || currentImageId;
        if (!imageId) {
          showToast('未选择图片，无法回复');
          return;
        }
        // 客户端二次校验：切图后拒绝发送
        if (currentImageId && imageId !== currentImageId) {
          showToast('当前会话已切换图片，请重新打开回复表单');
          return;
        }
        const input = document.getElementById('replyInput-' + parentId);
        if (!input) {
          console.warn('submitReply: 找不到 replyInput-' + parentId);
          showToast('回复表单已失效，请重新打开回复');
          return;
        }
        const content = (input.value || '').trim();
        if (content.length < 2) {
          showToast('回复内容至少 2 个字符');
          return;
        }
        const sendBtn = body.querySelector('.reply-form-send[data-parent-id="' + parentId + '"]');
        if (sendBtn) sendBtn.disabled = true;

        try {
          const auth = window.auth || {};
          const authedUser = (typeof auth.isLoggedIn === 'function' && auth.isLoggedIn()) ? auth.getUser() : null;
          const authedToken = (typeof auth.getToken === 'function') ? auth.getToken() : null;
          const username = authedUser ? (authedUser.display_name || authedUser.username) : getCurrentDisplayName();

          const payload = {
            image_id: imageId,
            content,
            github_username: username,
            parent_id: parentId,
            reply_to_username: replyToUsername || null,
          };
          if (authedToken) payload.user_token = authedToken;

          const resp = await callCommentApi('create', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.success === false) {
            // 把后端 body 完整回显，方便排查
            let detail = data.error || 'HTTP ' + resp.status;
            if (data && data.message) detail = data.message + ' | ' + detail;
            throw new Error(detail);
          }
          showToast('回复成功');

          // 1) 隐藏当前回复表单
          hideReplyForm(parentId);

          // 2) 把新回复写进缓存（如有），更新计数
          const newReply = data.data || {};
          newReply.liked_by_me = false;
          newReply.likes_count = 0;
          const cache = replyCache[parentId];
          if (cache) {
            cache.items = cache.items || [];
            cache.items.push(newReply);
            cache.lastCount = cache.items.length;
            cache.expanded = true;
          }

          // 3) 重新渲染该父评论的回复列表（自动展开）
          renderReplyList(parentId, cache ? cache.items : [newReply]);

          // 4) 同步更新顶级评论上的"查看 N 条回复" 按钮
          const toggleBtn = body.querySelector('.comment-replies-toggle[data-parent-id="' + parentId + '"]');
          const parentItem = body.querySelector('.comment-item[data-comment-id="' + parentId + '"]');
          if (parentItem) {
            const newCount = (cache ? cache.items.length : 1);
            if (toggleBtn) {
              toggleBtn.style.display = '';
              toggleBtn.dataset.action = 'hide';
              toggleBtn.innerHTML =
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>' +
                '<span>收起回复 (' + newCount + ')</span>';
            }
          }

          // 5) 总评论数 +1
          const totalBadge = document.getElementById('commentsCountBadge');
          if (totalBadge) {
            const m = totalBadge.textContent.match(/(\d+)/);
            if (m) {
              const newTotal = parseInt(m[1], 10) + 1;
              updateCommentsCountBadge(newTotal);
              if (window.commentCountsData) window.commentCountsData[String(currentImageId)] = newTotal;
              if (typeof updateLightboxCommentCount === 'function' && window.currentLightboxImageId === currentImageId) {
                updateLightboxCommentCount(newTotal);
              }
            }
          }
        } catch (e) {
          if (!isAbortError(e)) {
            console.error('回复失败:', e);
            showToast('回复失败：' + (e.message || '网络错误'));
          }
          if (sendBtn) sendBtn.disabled = false;
        }
      }

      function updateCommentsCountBadge(count) {
        const badge = document.getElementById('commentsCountBadge');
        if (badge) {
          // 修复: 与 updateLightboxCommentCount 一致,99+ 截断
          const display = (typeof count === 'number' && count > 99) ? '99+' : (count || 0);
          badge.textContent = display + ' 条评论';
        }
      }

      // === 提交顶级评论 ===
      async function submitComment() {
        const input = document.getElementById('commentInput');
        const content = input.value.trim();
        if (!content || content.length < 2) {
          showToast('评论内容至少2个字符');
          return;
        }
        if (!currentImageId) return;

        // 如果当前正打开着某条评论的回复表单，视为发到该评论的回复
        if (activeReplyParentId && pendingReplyTarget) {
          // 校验切图：切图后不允许把主输入框内容作为回复发出
          if (currentImageId && pendingReplyTarget.imageId && pendingReplyTarget.imageId !== currentImageId) {
            hideReplyForm(activeReplyParentId);
            showToast('已切换图片，请重新输入评论内容');
            return;
          }
          await submitReply(pendingReplyTarget.parentId, pendingReplyTarget.replyToUsername, pendingReplyTarget.imageId);
          input.value = '';
          return;
        }

        const btn = document.getElementById('commentSubmitBtn');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = '发送中…';

        try {
          const auth = window.auth || {};
          const authedUser = (typeof auth.isLoggedIn === 'function' && auth.isLoggedIn()) ? auth.getUser() : null;
          const authedToken = (typeof auth.getToken === 'function') ? auth.getToken() : null;
          const username = authedUser
            ? (authedUser.display_name || authedUser.username)
            : getCurrentDisplayName();

          const bodyPayload = {
            image_id: currentImageId,
            content: content,
            github_username: username,
          };
          if (authedToken) bodyPayload.user_token = authedToken;

          const resp = await callCommentApi('create', {
            method: 'POST',
            body: JSON.stringify(bodyPayload),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.success === false) {
            throw new Error(data.error || 'HTTP ' + resp.status);
          }
          input.value = '';
          showToast(data.message || '评论发布成功');
          loadCommentsFor(currentImageId, 1, currentCommentsSort);

          // P1 阶段 C-1: 广播新评论已发布, badge / 其他 UI 自动刷新
          try {
            window.EventBus && window.EventBus.emit('comment:posted', {
              imageId: currentImageId,
              source: 'submit',
            });
          } catch (_) { /* ignore */ }
        } catch (e) {
          if (!isAbortError(e)) {
            console.error('评论提交失败:', e.message);
            showToast('评论提交失败: ' + e.message);
          }
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      // 绑定提交按钮
      document.getElementById('commentSubmitBtn')?.addEventListener('click', submitComment);
      document.getElementById('commentInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitComment();
        }
      });

      // 排序切换（前端 'newest' | 'hottest' -> 后端 'newest' | 'likes'）
      const SORT_MAP = { newest: 'newest', hottest: 'likes', oldest: 'oldest' };
      document.querySelectorAll('[data-comment-sort]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('[data-comment-sort]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const uiSort = btn.dataset.commentSort;
          currentCommentsSort = SORT_MAP[uiSort] || 'newest';
          if (currentImageId) loadCommentsFor(currentImageId, 1, currentCommentsSort);
        });
      });

      // === 打开指定图片的评论 ===
      function showCommentsFor(threadKey, title, subtitle) {
        state.currentThread = threadKey;
        state.currentTitle = title;
        state.currentSubtitle = subtitle;
        titleEl.textContent = title;
        subtitleEl.textContent = subtitle;
        openDrawer();

        // 显示工具栏
        const toolbar = document.getElementById('commentsToolbar');
        if (toolbar) toolbar.style.display = 'flex';

        // 关闭当前可能打开的回复表单（切图必然清空旧回复）
        if (activeReplyParentId != null) hideReplyForm(activeReplyParentId);

        // 提取图片ID并加载评论（同步先写 currentImageId，避免 reply 闭包读到旧值）
        const imageId = parseInt(threadKey.replace('image-', ''), 10);
        if (imageId && imageId > 0) {
          currentImageId = imageId;
          loadCommentsFor(imageId, 1, 'newest');
        } else {
          body.innerHTML = '<div class="comments-empty"><div class="comments-empty-icon">🌐</div><div class="comments-empty-title">整站讨论</div><div class="comments-empty-desc">请访问 GitHub Discussions 参与整站话题讨论</div></div>';
        }
      }

      // === 卡片角标更新 ===
      function updateBadge(threadKey, count) {
        if (threadKey.startsWith('image-')) {
          const imgId = threadKey.replace('image-', '');
          // 同步写入全局缓存
          if (window.commentCountsData) {
            window.commentCountsData[imgId] = count;
          }
          const card = document.querySelector('.image-card[data-id="' + imgId + '"]');
          if (card) {
            const btn = card.querySelector('.comment-btn');
            if (btn) {
              let badge = btn.querySelector('.comment-count-badge');
              if (count > 0) {
                if (!badge) { badge = document.createElement('span'); badge.className = 'comment-count-badge'; btn.appendChild(badge); }
                badge.textContent = count > 99 ? '99+' : count;
              } else if (badge) { badge.remove(); }
            }
          }
          // ✅ 同步 lightbox 工具栏的评论数（如果当前显示的就是这张图片）
          if (typeof updateLightboxCommentCount === 'function' &&
              String(window.currentLightboxImageId) === String(imgId)) {
            updateLightboxCommentCount(count);
          }
        }
        const lightboxCount = document.getElementById('lightboxCommentCount');
        if (lightboxCount && state.currentThread === threadKey) {
          lightboxCount.textContent = count;
        }
      }

      // === 各处入口绑定 ===

      // 1) 顶部导航评论按钮
      const navCommentsBtn = document.getElementById('navCommentsBtn');
      if (navCommentsBtn) {
        navCommentsBtn.addEventListener('click', () => {
          showCommentsFor('site', '整站讨论', 'GitHub Discussions · 真实模式');
        });
      }

      // 2) Lightbox 工具栏评论按钮
      // 注意：openLightbox/navigateLightbox 用的是 window.sortedImages 索引，因此评论入口必须读 window.sortedImages
      // 否则在分类筛选后 filteredImages 与 window.sortedImages 顺序不一致时，lightbox 评论会指向错图
      const lightboxComment = document.getElementById('lightboxComment');
      if (lightboxComment) {
        lightboxComment.addEventListener('click', () => {
          if (currentLightboxIndex < 0) return;
          const img = window.sortedImages[currentLightboxIndex];
          if (!img) return;
          showCommentsFor('image-' + img.id, '评论 · ' + img.title, '图片 #' + img.id + ' · GitHub Discussions');
        });
      }

      // 3) 卡片评论按钮
      function attachCommentBtn(card, img) {
        if (card.querySelector('.comment-btn')) return;
        const actions = card.querySelector('.image-card-actions');
        if (!actions) return;
        const btn = document.createElement('button');
        btn.className = 'card-action-btn comment-btn';
        btn.title = '评论';
        btn.setAttribute('aria-label', 'View comments');
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          showCommentsFor('image-' + img.id, '评论 · ' + img.title, '图片 #' + img.id + ' · GitHub Discussions');
        });
        actions.appendChild(btn);
      }

      // 4) 监听 DOM 变化
      const galleryGridEl = document.getElementById('galleryGrid');
      if (galleryGridEl) {
        const mo = new MutationObserver(() => {
          galleryGridEl.querySelectorAll('.image-card').forEach(card => {
            const id = card.dataset.id;
            if (!id) return;
            const img = window.imageData.find(i => String(i.id) === String(id));
            if (img) attachCommentBtn(card, img);
          });
        });
        mo.observe(galleryGridEl, { childList: true });
        setTimeout(() => {
          galleryGridEl.querySelectorAll('.image-card').forEach(card => {
            const id = card.dataset.id;
            if (!id) return;
            const img = window.imageData.find(i => String(i.id) === String(id));
            if (img) attachCommentBtn(card, img);
          });
        }, 0);
      }

      // 5) URL hash 直接打开
      function checkHashOnLoad() {
        const m = (location.hash || '').match(/^#comments-(.+)$/);
        if (m) {
          const thread = m[1];
          if (thread === 'site') {
            showCommentsFor('site', '整站讨论', 'GitHub Discussions · 真实模式');
          } else if (thread.startsWith('image-')) {
            const id = thread.replace('image-', '');
            const img = window.imageData.find(i => String(i.id) === id);
            if (img) showCommentsFor(thread, '评论 · ' + img.title, '图片 #' + img.id);
          }
        }
      }
      window.addEventListener('hashchange', checkHashOnLoad);
      setTimeout(checkHashOnLoad, 100);

      // 6) 控制台配置检查器
      window.StellarCommentsCheck = function() {
        const lines = [
          '%c  Stellar Comments 配置检查器  ',
          'background: #D4A853; color: #08080C; padding: 4px 12px; font-weight: bold;',
          '',
          'Giscus 已配置：' + (isConfigured ? '✅ 是' : '❌ 否（占位符未替换）'),
          '仓库：' + GISCUS_CONFIG.repo,
          'repo-id：' + GISCUS_CONFIG.repoId,
          'category-id：' + GISCUS_CONFIG.categoryId,
          '子站地址：' + COMMENTS_BASE,
          '',
          isConfigured ? '✓ 真实模式已启用，评论会保存到 GitHub Discussions' : '⚠ 当前显示配置引导界面，替换占位符后启用真实模式',
          '',
          '配置步骤：',
          '1. 启用仓库 ' + GISCUS_CONFIG.repo + ' 的 Discussions',
          '2. 访问 https://giscus.app/zh-CN 配置',
          '3. 替换 GISCUS_CONFIG.repoId / categoryId',
          '4. 推送部署即可',
        ];
        console.log('%c' + lines[0], lines[1]);
        for (let i = 2; i < lines.length; i++) console.log(lines[i]);
        return { isConfigured, repo: GISCUS_CONFIG.repo, base: COMMENTS_BASE };
      };

      window.StellarComments = { state, showCommentsFor, isConfigured };
      window.showCommentsFor = showCommentsFor;
    })();
  

