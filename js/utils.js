// =====================================================================
// utils.js
// 通用工具函数集合(纯函数 + DOM util)
// 老代码可以继续用 IIFE 内的本地函数; 新代码应该用 window.Utils.xxx
//
// 维护规则:
//   - 改这里就改了全站, 老函数如果还在被引用可以保留, 但新写的请用这里的
// =====================================================================

(function (global) {
  'use strict';

  const Utils = {
    // ==================== 字符串 ====================

    /**
     * HTML 转义(防 XSS)
     * 用法: 任何 user-controlled 字符串插入到 innerHTML 之前都该过这个
     * @param {*} text
     * @returns {string}
     */
    escapeHtml(text) {
      if (text == null) return '';
      const div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    },

    /**
     * 反转义 HTML 实体(小心使用, 通常不需要)
     * @param {string} html
     * @returns {string}
     */
    unescapeHtml(html) {
      if (html == null) return '';
      const div = document.createElement('div');
      div.innerHTML = String(html);
      return div.textContent || '';
    },

    /**
     * 截断字符串
     * @param {string} str
     * @param {number} max
     * @param {string} [ellipsis='…']
     * @returns {string}
     */
    truncate(str, max, ellipsis = '…') {
      if (str == null) return '';
      str = String(str);
      if (str.length <= max) return str;
      return str.slice(0, max) + ellipsis;
    },

    // ==================== 时间 ====================

    /**
     * 秒数 → "m:ss" 格式
     * @param {number} sec
     * @returns {string}
     */
    formatTime(sec) {
      if (sec == null || isNaN(sec) || !isFinite(sec) || sec < 0) return '--:--';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    },

    /**
     * ISO 时间 → "刚刚 / x 分钟前 / x 小时前 / x 天前 / 具体日期"
     * @param {string} iso
     * @returns {string}
     */
    formatRelativeTime(iso) {
      if (!iso) return '';
      const ts = new Date(iso).getTime();
      if (isNaN(ts)) return '';
      const diff = Date.now() - ts;
      if (diff < 0) return '刚刚';
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
      if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
      const d = new Date(ts);
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    },

    // ==================== 函数式 ====================

    /**
     * 函数防抖(最后一次调用后 wait 毫秒才执行)
     * @param {function} fn
     * @param {number} wait
     * @returns {function}
     */
    debounce(fn, wait) {
      let timer = null;
      return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
      };
    },

    /**
     * 函数节流(每隔 wait 毫秒最多执行一次)
     * @param {function} fn
     * @param {number} wait
     * @returns {function}
     */
    throttle(fn, wait) {
      let last = 0;
      let timer = null;
      return function (...args) {
        const now = Date.now();
        if (now - last >= wait) {
          last = now;
          fn.apply(this, args);
        } else if (!timer) {
          timer = setTimeout(() => {
            last = Date.now();
            timer = null;
            fn.apply(this, args);
          }, wait - (now - last));
        }
      };
    },

    // ==================== DOM ====================

    /**
     * 安全的 querySelector, 找不到返回 null 而不抛错
     * @param {string} selector
     * @param {ParentNode} [parent=document]
     * @returns {Element|null}
     */
    $(selector, parent = document) {
      try { return parent.querySelector(selector); } catch { return null; }
    },

    /**
     * querySelectorAll 转数组
     * @param {string} selector
     * @param {ParentNode} [parent=document]
     * @returns {Element[]}
     */
    $$(selector, parent = document) {
      try {
        return Array.from(parent.querySelectorAll(selector));
      } catch {
        return [];
      }
    },

    /**
     * 显示 / 隐藏元素(给 .hidden class 切换)
     * @param {Element} el
     * @param {boolean} show
     */
    toggle(el, show) {
      if (!el) return;
      el.classList.toggle('hidden', !show);
    },

    /**
     * 创建元素 + 设置属性
     * @param {string} tag
     * @param {Object} [attrs={}]
     * @param {Element[]|string} [children=[]]
     * @returns {Element}
     */
    h(tag, attrs = {}, children = []) {
      const el = document.createElement(tag);
      for (const k in attrs) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k]);
        else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (k === 'dataset' && typeof attrs[k] === 'object') Object.assign(el.dataset, attrs[k]);
        else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      }
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c == null) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return el;
    },

    // ==================== 网络 ====================

    /**
     * 带超时的 fetch(默认 15s)
     * @param {string} url
     * @param {RequestInit} [opts]
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<Response>}
     */
    async fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...opts, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * 检查 Supabase Edge Function 网关错误(401 / 403 / 404)
     * 用于区分函数内部返回 vs 网关拦截
     * @param {Response} resp
     * @returns {{ isGatewayError: boolean, status: number, message: string }}
     */
    inspectFunctionError(resp) {
      const status = resp.status;
      const isGatewayError = status === 401 || status === 403 || status === 404;
      let message = '';
      if (isGatewayError) {
        if (status === 401) message = '鉴权失败,可能 Verify JWT 没关';
        else if (status === 403) message = 'originGuard 拦截或权限不足';
        else if (status === 404) message = '函数或路径不存在';
      }
      return { isGatewayError, status, message };
    },

    // ==================== 杂项 ====================

    /**
     * 生成短随机 ID
     * @param {number} [len=8]
     * @returns {string}
     */
    shortId(len = 8) {
      return Math.random().toString(36).slice(2, 2 + len);
    },

    /**
     * 获取或生成访客唯一标识（统一实现，避免各模块重复生成）
     * @returns {string} visitor_id
     */
    getVisitorId() {
      try {
        let id = localStorage.getItem('visitor_id');
        if (!id) {
          id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
          localStorage.setItem('visitor_id', id);
        }
        return id;
      } catch (e) {
        // localStorage 不可用时生成临时 ID
        return 'tmp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      }
    },

    /**
     * 浅克隆对象(JSON 安全)
     * @param {*} obj
     * @returns {*}
     */
    clone(obj) {
      if (obj == null) return obj;
      try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
    },
  };

  global.Utils = Utils;

  // 抑制已知第三方扩展/子模块抛出的非关键错误，避免污染控制台
  // 注意：仅过滤消息匹配的白名单，项目自身代码的错误仍会正常上报
  const KNOWN_NOISE_ERRORS = [
    /getThemeColors/i,
    /themeColors/i,
    /exportedColors/i,
  ];
  function isKnownNoiseError(message) {
    if (!message) return false;
    return KNOWN_NOISE_ERRORS.some(re => re.test(String(message)));
  }
  window.addEventListener('error', function (e) {
    if (isKnownNoiseError(e.message)) {
      e.preventDefault();
      console.warn('[suppressed known noise error]', e.message);
      return;
    }
  });
  window.addEventListener('unhandledrejection', function (e) {
    const msg = e.reason && (e.reason.message || e.reason);
    if (isKnownNoiseError(msg)) {
      e.preventDefault();
      console.warn('[suppressed known noise rejection]', msg);
    }
  });
})(window);
