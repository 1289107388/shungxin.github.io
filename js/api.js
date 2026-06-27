(function(global) {
  'use strict';

  // === Supabase 配置（暴露到全局，供其他 IIFE 使用） ===
  // P1 阶段 A: 优先从 window.AppConfig 读, config.js 已经把 SUPABASE_CONFIG 别名也设置好
  // 这里不再硬编码, 改 url/anonKey 只改 config.js 即可
  global.SUPABASE_CONFIG = (global.AppConfig && global.AppConfig.SUPABASE)
    ? { url: global.AppConfig.SUPABASE.url, anonKey: global.AppConfig.SUPABASE.anonKey }
    : (global.SUPABASE_CONFIG || { url: 'https://qlhfyawbyedhqokivezn.supabase.co', anonKey: '' });
  const SUPABASE_CONFIG = global.SUPABASE_CONFIG;

  // 判断是否为请求被中止/取消的错误（页面卸载、AbortController、用户中断）
  function isAbortError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err.message || err).toLowerCase();
    return msg.includes('aborted') || msg.includes('abort') || msg.includes('cancel');
  }

  // 通用 Edge Function 调用（纯 fetch，不依赖 SDK；带超时和 abort 静默处理）
  global.supabaseInvoke = async function(functionName, body) {
    const url = SUPABASE_CONFIG.url + '/functions/v1/' + functionName;
    console.log('[supabaseInvoke] POST', url, body);
    
    // 构建 headers: apikey 始终传; Authorization 优先用用户 token,未登录则用 anonKey
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
    };
    // 尝试从 localStorage 读取用户 token(兼容 auth 模块的 key)
    const userToken = localStorage.getItem('shungxin_auth_token');
    if (userToken) {
      headers['Authorization'] = 'Bearer ' + userToken;
    }
    
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
      });
    } catch (networkErr) {
      if (isAbortError(networkErr)) {
        console.warn('[supabaseInvoke] 请求已取消:', functionName);
        throw new Error('请求已取消');
      }
      console.error('[supabaseInvoke] 网络错误:', networkErr.message, networkErr);
      throw new Error('网络错误: ' + networkErr.message);
    }
    console.log('[supabaseInvoke] 响应:', resp.status, resp.statusText);
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[supabaseInvoke] HTTP错误:', resp.status, text);
      throw new Error('HTTP ' + resp.status + ': ' + text);
    }
    return await resp.json();
  };

  const supabaseReady = SUPABASE_CONFIG.url !== 'YOUR_SUPABASE_URL' && SUPABASE_CONFIG.anonKey !== 'YOUR_SUPABASE_ANON_KEY';

  // 获取当前登录用户 ID；未登录返回 null
  function getCurrentUserId() {
    try {
      const auth = global.auth;
      if (auth && typeof auth.isLoggedIn === 'function' && auth.isLoggedIn()) {
        const u = auth.getUser && auth.getUser();
        if (u && u.id) return String(u.id);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 本地点赞状态（内存缓存，刷新即失效；登录后从后端 /my-likes 拉取）
  const localLikes = {};

  // === 批量获取所有图片点赞数（通过 Edge Function） ===
  async function loadAllLikeCounts() {
    const counts = {};
    if (!supabaseReady) {
      // 演示模式：随机生成点赞数
      if (global.imageData) {
        global.imageData.forEach(img => {
          counts[img.id] = Math.floor(Math.random() * 50) + 1;
        });
      }
    } else {
      try {
        // 通过 Edge Function 获取（前端禁止直连数据库）
        const likeHeaders = {
          'apikey': global.SUPABASE_CONFIG.anonKey,
          'Authorization': 'Bearer ' + global.SUPABASE_CONFIG.anonKey,
        };
        const userToken = localStorage.getItem('shungxin_auth_token');
        if (userToken) likeHeaders['Authorization'] = 'Bearer ' + userToken;
        const resp = await fetch(
          global.SUPABASE_CONFIG.url + '/functions/v1/like-toggle/counts',
          { headers: likeHeaders }
        );
        const result = await resp.json();
        if (result.success && result.data) {
          Object.assign(counts, result.data);
        }
      } catch (e) {
        if (!isAbortError(e)) console.warn('获取点赞数失败:', e.message);
      }
    }
    return counts;
  }

  // === 点赞/取消点赞（通过 Edge Function 安全执行） ===
  async function toggleLike(imageId) {
    const btn = document.querySelector(`.like-btn[data-id="${imageId}"]`);
    const countEl = document.querySelector(`.like-count[data-id="${imageId}"]`);
    if (!btn || !countEl) return;

    const userId = getCurrentUserId();
    if (!userId) {
      if (typeof global.showToast === 'function') global.showToast('请先登录后再点赞');
      // 可选：自动打开登录弹窗
      try { global.openAuthModal && global.openAuthModal('login'); } catch (_) {}
      return;
    }

    const isLiked = localLikes[imageId];
    let currentCount = parseInt(countEl.textContent) || 0;

    if (!supabaseReady) {
      // 演示模式：仅本地存储
      if (isLiked) {
        localLikes[imageId] = false;
        currentCount = Math.max(0, currentCount - 1);
        btn.classList.remove('liked');
      } else {
        localLikes[imageId] = true;
        currentCount += 1;
        btn.classList.add('liked');
      }
      countEl.textContent = currentCount;
      if (typeof global.showToast === 'function') {
        global.showToast(isLiked ? '已取消点赞' : '点赞成功（演示模式）');
      }
      return;
    }

    // 真实模式：通过 Edge Function 操作数据库
    try {
      btn.disabled = true;

      const action = isLiked ? 'unlike' : 'like';
      const result = await global.supabaseInvoke('like-toggle', {
        image_id: imageId,
        action: action,
      });

      if (!result.success) throw new Error(result.message || result.error || 'Edge Function 返回错误');

      const data = result.data || {};
      // 更新 UI
      if (data.action === 'like') {
        localLikes[imageId] = true;
        btn.classList.add('liked');
        countEl.textContent = data.count || (currentCount + 1);
        if (typeof global.showToast === 'function') {
          global.showToast('点赞成功');
        }
      } else {
        localLikes[imageId] = false;
        btn.classList.remove('liked');
        countEl.textContent = data.count || Math.max(0, currentCount - 1);
        if (typeof global.showToast === 'function') {
          global.showToast('已取消点赞');
        }
      }

      // P1 阶段 C-1: 广播点赞状态变化, 其他 UI(lightbox / 卡片 badge)能监听
      try {
        global.EventBus && global.EventBus.emit('like:update', {
          imageId: imageId,
          liked: data.action === 'like',
          count: parseInt(countEl.textContent, 10) || 0,
          source: 'edge-function',
        });
      } catch (_) { /* ignore */ }
    } catch (e) {
      console.error('点赞操作失败:', e.message);
      // 请求被主动取消时不做离线回退，避免误导用户
      if (isAbortError(e)) {
        if (typeof global.showToast === 'function') global.showToast('操作已取消');
        return;
      }
      // 回退到乐观更新
      if (isLiked) {
        localLikes[imageId] = false;
        btn.classList.remove('liked');
        countEl.textContent = Math.max(0, currentCount - 1);
      } else {
        localLikes[imageId] = true;
        btn.classList.add('liked');
        countEl.textContent = currentCount + 1;
      }
      if (typeof global.showToast === 'function') {
        global.showToast('网络异常: ' + e.message + ' (已离线更新)');
      }

      // P1 阶段 C-1: 离线回退也广播
      try {
        global.EventBus && global.EventBus.emit('like:update', {
          imageId: imageId,
          liked: !isLiked,
          count: parseInt(countEl.textContent, 10) || 0,
          source: 'optimistic-fallback',
        });
      } catch (_) { /* ignore */ }
    } finally {
      btn.disabled = false;
    }
  }

  // === 获取当前登录用户已点赞的图片 ID 列表 ===
  async function loadMyLikes() {
    const userId = getCurrentUserId();
    if (!userId || !supabaseReady) return [];
    try {
      const headers = { 'apikey': global.SUPABASE_CONFIG.anonKey };
      const userToken = localStorage.getItem('shungxin_auth_token');
      if (userToken) headers['Authorization'] = 'Bearer ' + userToken;
      const resp = await fetch(
        global.SUPABASE_CONFIG.url + '/functions/v1/like-toggle/my-likes',
        { headers }
      );
      const result = await resp.json();
      if (result.success && Array.isArray(result.data)) {
        return result.data;
      }
    } catch (e) {
      if (!isAbortError(e)) console.warn('获取我的点赞失败:', e.message);
    }
    return [];
  }

  // === 初始化点赞 UI ===
  async function initLikesUI() {
    const counts = await loadAllLikeCounts();
    global.likeCountsData = { ...counts };

    // 登录用户从后端拉取已点赞列表
    const myLikes = await loadMyLikes();
    myLikes.forEach(id => { localLikes[id] = true; });

    // 更新所有点赞按钮状态和计数
    document.querySelectorAll('.like-btn').forEach(btn => {
      const imageId = btn.dataset.id;
      const countEl = btn.querySelector('.like-count');
      if (countEl) {
        countEl.textContent = counts[imageId] || 0;
      }
      if (localLikes[imageId]) {
        btn.classList.add('liked');
      }
    });
  }

  // 暴露全局方法
  global.toggleLike = toggleLike;
  global.loadAllLikeCounts = loadAllLikeCounts;
  global.loadMyLikes = loadMyLikes;
  global.initLikesUI = initLikesUI;
  global.supabaseReady = supabaseReady;

  // === Supabase 浏览量统计系统 ===
  (function() {
    'use strict';

    // 获取 Supabase 是否已配置（纯 fetch 实现，不需要 SDK）
    function getSupabaseClient() {
      if (global.SUPABASE_CONFIG &&
          global.SUPABASE_CONFIG.url !== 'YOUR_SUPABASE_URL' &&
          global.SUPABASE_CONFIG.anonKey !== 'YOUR_SUPABASE_ANON_KEY') {
        return { ready: true };
      }
      return null;
    }

    // === 批量获取所有图片浏览量（通过 Edge Function） ===
    async function loadAllViewCounts() {
      const counts = {};
      const client = getSupabaseClient();

      if (!client) {
        // 演示模式：随机生成浏览量
        if (global.imageData) {
          global.imageData.forEach(img => {
            counts[img.id] = Math.floor(Math.random() * 500) + 10;
          });
        }
      } else {
        try {
          // 通过 Edge Function 获取（前端禁止直连数据库）
          const viewListHeaders = {
            'apikey': global.SUPABASE_CONFIG.anonKey,
            'Authorization': 'Bearer ' + global.SUPABASE_CONFIG.anonKey,
          };
          const userToken = localStorage.getItem('shungxin_auth_token');
          if (userToken) viewListHeaders['Authorization'] = 'Bearer ' + userToken;
          const resp = await fetch(
            global.SUPABASE_CONFIG.url + '/functions/v1/view-count/list',
            { headers: viewListHeaders }
          );
          const result = await resp.json();
          if (result.success && result.data) {
            Object.assign(counts, result.data);
          }
        } catch (e) {
          if (!isAbortError(e)) console.warn('获取浏览量失败:', e.message);
        }
      }
      return counts;
    }

    // === 增加浏览量（通过 Edge Function，仅登录用户） ===
    async function incrementViewCount(imageId) {
      const client = getSupabaseClient();

      // 仅登录用户增加浏览量；游客直接跳过
      const userToken = localStorage.getItem('shungxin_auth_token');
      if (!userToken) return;

      if (!client) {
        // 演示模式：本地计数
        const viewCountsData = global.viewCountsData || {};
        viewCountsData[imageId] = (viewCountsData[imageId] || 0) + 1;
        global.viewCountsData = viewCountsData;
        updateViewCountBadge(imageId, viewCountsData[imageId]);
        return;
      }

      try {
        // 通过 Edge Function 增加浏览量（前端禁止直连数据库）
        const incHeaders = {
          'Content-Type': 'application/json',
          'apikey': global.SUPABASE_CONFIG.anonKey,
          'Authorization': 'Bearer ' + userToken,
        };
        const resp = await fetch(
          global.SUPABASE_CONFIG.url + '/functions/v1/view-count/increment',
          {
            method: 'POST',
            headers: incHeaders,
            body: JSON.stringify({ image_id: imageId }),
          }
        );
        const result = await resp.json();
        if (result.success && result.data) {
          global.viewCountsData[imageId] = result.data.count;
          updateViewCountBadge(imageId, result.data.count);

          // P1 阶段 C-1: 广播浏览量变化
          try {
            global.EventBus && global.EventBus.emit('view:update', {
              imageId: imageId,
              count: result.data.count,
              source: 'edge-function',
            });
          } catch (_) { /* ignore */ }
        }
      } catch (e) {
        if (!isAbortError(e)) console.warn('浏览量增加失败:', e.message);
      }
    }

    // === 更新浏览量徽章 ===
    function updateViewCountBadge(imageId, count) {
      const card = document.querySelector('.image-card[data-id="' + imageId + '"]');
      if (!card) return;

      let badge = card.querySelector('.view-count-badge');
      const safeCount = parseInt(count, 10) || 0;
      if (safeCount <= 0) {
        if (badge) badge.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'view-count-badge';
        badge.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span class="view-count-number">${safeCount}</span>
        `;
        const inner = card.querySelector('.image-card-inner');
        const img = inner ? inner.querySelector('.image-card-img') : null;
        if (inner && img) {
          if (img.nextSibling) {
            inner.insertBefore(badge, img.nextSibling);
          } else {
            inner.appendChild(badge);
          }
        }
      } else {
        const numSpan = badge.querySelector('.view-count-number');
        if (numSpan) numSpan.textContent = safeCount;
      }
    }

    // === 初始化浏览量 UI ===
    async function initViewsUI() {
      const counts = await loadAllViewCounts();
      global.viewCountsData = { ...counts };

      // 更新所有浏览量徽章
      Object.entries(counts).forEach(([imageId, count]) => {
        if (count > 0) {
          updateViewCountBadge(parseInt(imageId), count);
        }
      });

      // P1 阶段 C-1: 一次性广播所有浏览量, 监听者能预热
      try {
        global.EventBus && global.EventBus.emit('view:init', {
          counts: counts,
          source: 'init',
        });
      } catch (_) { /* ignore */ }
    }

    // 首次加载初始化
    setTimeout(initViewsUI, 800);

    // 暴露全局方法
    global.incrementViewCount = incrementViewCount;
    global.loadAllViewCounts = loadAllViewCounts;
    global.initViewsUI = initViewsUI;
  })();

  // 暴露模块
  global.Api = {
    supabaseInvoke: global.supabaseInvoke,
    toggleLike: toggleLike,
    incrementViewCount: global.incrementViewCount,
    loadAllLikeCounts: loadAllLikeCounts,
    loadAllViewCounts: global.loadAllViewCounts,
    initLikesUI: initLikesUI,
    initViewsUI: global.initViewsUI,
  };
})(window);
