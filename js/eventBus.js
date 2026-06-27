// =====================================================================
// eventBus.js
// 全站发布订阅事件总线
// 替代散落的 window.xxx = function() 互相调用的模式
//
// 约定事件名(命名空间:冒号):
//   auth:login / auth:logout / auth:changed
//   like:update    { imageId, liked, count }
//   view:update    { imageId, count }
//   comment:update { imageId, total }
//   lightbox:open  { imageId }
//   lightbox:close
//   gallery:filter:change { filter }
//   gallery:sort:change   { sort }
//   gallery:rebuild       (整个画廊重渲染)
//
// 用法:
//   // 订阅
//   const off = EventBus.on('like:update', (e) => { console.log(e.detail); });
//   // ... 业务代码
//   off();   // 取消订阅
//
//   // 发布
//   EventBus.emit('like:update', { imageId: 1, liked: true, count: 10 });
//
// 本地调试:
//   在 index.html 加载本文件之前, 设置 window.__EVENTBUS_DEBUG__ = true
//   之后所有 emit() 会自动在 console 打印 eventName + 监听者数量 + payload
//   生产部署前请务必改回 false, 避免控制台被刷屏
// =====================================================================

(function (global) {
  'use strict';

  // 用 Map 而不是对象, 方便删除和清理
  const listeners = new Map(); // eventName -> Set<fn>

  const EventBus = {
    /**
     * 订阅事件
     * @param {string} eventName
     * @param {function} handler - 接收一个 CustomEvent, handler(e)
     * @returns {function} 取消订阅函数
     */
    on(eventName, handler) {
      if (typeof eventName !== 'string' || typeof handler !== 'function') {
        console.warn('[EventBus] on() 参数错误:', eventName, handler);
        return () => {};
      }
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(handler);
      // 返回取消订阅函数
      return () => EventBus.off(eventName, handler);
    },

    /**
     * 一次性订阅
     */
    once(eventName, handler) {
      const off = EventBus.on(eventName, (e) => {
        off();
        handler(e);
      });
      return off;
    },

    /**
     * 取消订阅
     */
    off(eventName, handler) {
      if (!listeners.has(eventName)) return;
      const set = listeners.get(eventName);
      if (handler) set.delete(handler);
      else set.clear();
      if (set.size === 0) listeners.delete(eventName);
    },

    /**
     * 发布事件
     * @param {string} eventName
     * @param {*} [detail] - 传给 handler 的数据
     * @returns {boolean} - 是否有监听者(可用来判断要不要发请求)
     */
    emit(eventName, detail) {
      const has = listeners.has(eventName);
      if (global.__EVENTBUS_DEBUG__ === true) {
        const count = has ? listeners.get(eventName).size : 0;
        // eslint-disable-next-line no-console
        console.log(`[EventBus] emit "${eventName}" listeners=${count}`, detail);
      }
      if (!has) return false;
      const set = listeners.get(eventName);
      // 防御:在迭代时如果 handler 内部 off 不会影响当前循环
      const evt = {
        type: eventName,
        detail: detail,
        timeStamp: Date.now(),
      };
      for (const handler of Array.from(set)) {
        try {
          handler(evt);
        } catch (e) {
          console.error(`[EventBus] handler for "${eventName}" threw:`, e);
        }
      }
      return true;
    },

    // ---- 调试辅助: 主动写入一条事件日志(本地验证用) ----
    _debugLog(message, payload) {
      if (global.__EVENTBUS_DEBUG__ === true) {
        // eslint-disable-next-line no-console
        console.log(`[EventBus:dbg] ${message}`, payload);
      }
    },

    /**
     * 调试:列出所有活跃订阅
     * @returns {Object}
     */
    list() {
      const result = {};
      for (const [name, set] of listeners) {
        result[name] = set.size;
      }
      return result;
    },

    /**
     * 清空所有订阅(只在测试/切换页面时用)
     */
    clear() {
      listeners.clear();
    },
  };

  // 暴露到全局
  global.EventBus = EventBus;

  // 调试便利:浏览器控制台可用 window.eventBusList() 查看订阅
  global.eventBusList = () => {
    console.table(EventBus.list());
  };
})(window);
