// ============================================================
// 留言管理后台
// 访问入口: https://admin.yang181969.com
// 依赖后端: https://comment.yang181969.com/api/admin/*
// ============================================================

(function () {
  "use strict";

  const COMMENT_API_BASE = "https://comment.yang181969.com";
  const ADMIN_TOKEN_KEY = "yang_comment_admin_token";
  const INVALID_ADMIN_TOKENS = new Set(["你的ADMIN_TOKEN"]);

  const state = {
    page: 1,
    pageSize: 20,
    totalPages: 0,
    statusFilter: "all",
    comments: [],
    replyingTo: null, // 当前展开回复框的目标 id
  };

  function initCommentAdminPage() {
    const root = document.querySelector(".comment-admin-page");
    if (!root) return;

    bindLogin(root);
    bindPanel(root);

    const token = getStoredAdminToken();
    if (token) {
      enterPanel(root);
      loadComments(root, 1).catch((error) => {
        if (error.status === 401) {
          sessionStorage.removeItem(ADMIN_TOKEN_KEY);
          exitPanel(root, "登录已过期，请重新登录。");
        }
      });
    } else {
      exitPanel(root);
    }
  }

  window.initCommentAdminPage = initCommentAdminPage;

  // ============================================================
  // 登录 / 退出
  // ============================================================
  function bindLogin(root) {
    const form = root.querySelector("#comment-admin-login-form");
    const tokenInput = root.querySelector("#comment-admin-token");
    const message = root.querySelector("#comment-admin-login-message");
    const logoutBtn = root.querySelector("#comment-admin-logout");
    const loginBtn = form?.querySelector("button") || Array.from(root.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "进入后台");
    let loggingIn = false;

    async function login() {
      if (loggingIn) return;
      const token = normalizeAdminToken(tokenInput?.value || "");
      if (!token) {
        showMessage(message, "请填写有效的管理员密钥。", "error");
        return;
      }

      showMessage(message, "正在验证……", "info");
      loggingIn = true;
      try {
        const res = await fetch(`${COMMENT_API_BASE}/api/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const result = await res.json().catch(() => null);

        if (!res.ok || !result?.ok) {
          console.warn("[admin]", result?.message || `验证失败：${res.status}`);
          throw new Error(result?.message || `验证失败：${res.status}`);
        }

        sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
        if (tokenInput) tokenInput.value = "";
        hideMessage(message);

        enterPanel(root);
        await loadComments(root, 1);
      } catch (error) {
        showMessage(message, error.message || "管理员验证失败。", "error");
      } finally {
        loggingIn = false;
      }
    }

    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      login();
    });

    if (loginBtn && !(loginBtn.form === form && loginBtn.type === "submit")) {
      loginBtn.addEventListener("click", (event) => {
        event.preventDefault();
        login();
      });
    }

    logoutBtn?.addEventListener("click", () => {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      exitPanel(root, "已退出登录。");
    });
  }

  function enterPanel(root) {
    const loginCard = root.querySelector("#comment-admin-login-card");
    const panel = root.querySelector("#comment-admin-panel");
    const logoutBtn = root.querySelector("#comment-admin-logout");
    if (loginCard) loginCard.hidden = true;
    if (panel) panel.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  }

  function exitPanel(root, infoText) {
    const loginCard = root.querySelector("#comment-admin-login-card");
    const panel = root.querySelector("#comment-admin-panel");
    const logoutBtn = root.querySelector("#comment-admin-logout");
    const message = root.querySelector("#comment-admin-login-message");

    if (loginCard) loginCard.hidden = false;
    if (panel) panel.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;

    if (infoText) {
      showMessage(message, infoText, "info");
    } else {
      hideMessage(message);
    }
  }

  // ============================================================
  // 后台事件绑定
  // ============================================================
  function bindPanel(root) {
    const refreshBtn = root.querySelector("#comment-admin-refresh");
    const statusFilter = root.querySelector("#comment-admin-status-filter");
    const prevBtn = root.querySelector("#comment-admin-prev");
    const nextBtn = root.querySelector("#comment-admin-next");
    const list = root.querySelector("#comment-admin-list");

    refreshBtn?.addEventListener("click", () => loadComments(root, state.page));

    statusFilter?.addEventListener("change", () => {
      state.statusFilter = statusFilter.value || "all";
      loadComments(root, 1);
    });

    prevBtn?.addEventListener("click", () => {
      if (state.page > 1) loadComments(root, state.page - 1);
    });

    nextBtn?.addEventListener("click", () => {
      if (state.page < state.totalPages) loadComments(root, state.page + 1);
    });

    list?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-admin-action]");
      if (!target) return;
      const action = target.dataset.adminAction;
      const id = target.dataset.targetId;
      if (!action || !id) return;

      if (action === "reply") {
        toggleReplyBox(root, id);
        return;
      }
      if (action === "reply-submit") {
        submitReply(root, id);
        return;
      }
      if (action === "reply-cancel") {
        closeReplyBox(root);
        return;
      }
      if (action === "hide") {
        updateStatus(root, id, "hidden");
        return;
      }
      if (action === "restore") {
        updateStatus(root, id, "visible");
        return;
      }
      if (action === "delete") {
        if (confirm("确定将这条留言标记为已删除？前台将不再显示。")) {
          updateStatus(root, id, "deleted");
        }
      }
    });
  }

  // ============================================================
  // 加载列表
  // ============================================================
  async function loadComments(root, page = 1, options = {}) {
    const list = root.querySelector("#comment-admin-list");
    if (!list) return;

    const requestedPage = Math.max(Number.parseInt(page, 10) || 1, 1);
    list.innerHTML = `<div class="comment-admin-state">正在加载……</div>`;

    try {
      const params = new URLSearchParams({
        page: String(requestedPage),
        pageSize: String(state.pageSize),
        status: state.statusFilter,
      });
      const result = await adminFetch(`/api/admin/comments?${params.toString()}`);

      const comments = Array.isArray(result?.data?.comments) ? result.data.comments : [];
      const pagination = result?.data?.pagination || {};
      const totalPages = Math.max(Number(pagination.totalPages) || 0, 0);

      if (requestedPage > totalPages && totalPages > 0 && options.allowPageFallback !== false) {
        return loadComments(root, totalPages, { allowPageFallback: false });
      }

      state.comments = comments;
      state.page = totalPages > 0 ? (Number(pagination.page) || requestedPage) : 1;
      state.totalPages = totalPages;
      state.replyingTo = null;

      renderList(root, comments);
      renderPagination(root, {
        ...pagination,
        page: state.page,
        totalPages: state.totalPages,
      });
    } catch (error) {
      if (error.status === 401) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        exitPanel(root, "登录已过期，请重新登录。");
        throw error;
      }
      console.warn("[admin]", error.message || error);
      list.innerHTML = `<div class="comment-admin-state is-error">加载失败：${escapeHTML(error.message || "未知错误")}</div>`;
    }
  }

  // ============================================================
  // 渲染
  // ============================================================
  function renderList(root, comments) {
    const list = root.querySelector("#comment-admin-list");
    if (!list) return;

    if (!comments.length) {
      list.innerHTML = `<div class="comment-admin-state">暂时没有留言。</div>`;
      return;
    }

    list.innerHTML = comments.map(c => renderTopLevel(c)).join("");
  }

  function renderTopLevel(comment) {
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    const repliesHtml = replies.length
      ? `<div class="comment-admin-replies">${replies.map(r => renderReply(r)).join("")}</div>`
      : "";

    return `
      <article class="comment-admin-item${isAdminRole(comment) ? " is-owner" : ""} is-status-${escapeAttribute(comment.status || "visible")}" data-id="${escapeAttribute(comment.id)}">
        ${renderMeta(comment)}
        <div class="comment-admin-item__content">${formatContent(comment.content)}</div>
        ${renderActions(comment)}
        ${renderReplyBox(comment)}
        ${repliesHtml}
      </article>
    `;
  }

  function renderReply(reply) {
    return `
      <article class="comment-admin-reply${isAdminRole(reply) ? " is-owner" : ""} is-status-${escapeAttribute(reply.status || "visible")}" data-id="${escapeAttribute(reply.id)}">
        ${renderMeta(reply, { isReply: true })}
        <div class="comment-admin-item__content">
          ${reply.reply_to_name ? `<span class="comment-admin-mention">@${escapeHTML(reply.reply_to_name)}</span> ` : ""}
          ${formatContent(reply.content)}
        </div>
        ${renderActions(reply)}
        ${renderReplyBox(reply)}
      </article>
    `;
  }

  function renderMeta(item, opts = {}) {
    const nickname = escapeHTML(item.nickname || "访客");
    const admin = isAdminRole(item);
    const badge = admin
      ? `<span class="comment-admin-badge is-owner">站长</span>`
      : `<span class="comment-admin-badge">访客</span>`;
    const statusBadge = renderStatusBadge(item.status);
    const time = escapeHTML(formatDate(item.created_at));
    const idText = `#${escapeHTML(String(item.id))}`;
    const likes = Number(item.likes || 0);
    const sizeClass = opts.isReply ? " comment-admin-meta--reply" : "";

    return `
      <header class="comment-admin-meta${sizeClass}">
        <span class="comment-admin-meta__author">${nickname}</span>
        ${badge}
        ${statusBadge}
        <span class="comment-admin-meta__id">${idText}</span>
        <span class="comment-admin-meta__time">${time}</span>
        <span class="comment-admin-like-count" title="点赞数">⚡ ${likes}</span>
      </header>
    `;
  }

  function renderStatusBadge(status) {
    const s = status || "visible";
    if (s === "visible") return "";
    const label = s === "hidden" ? "已隐藏" : s === "deleted" ? "已删除" : s;
    return `<span class="comment-admin-status-tag is-${escapeAttribute(s)}">${escapeHTML(label)}</span>`;
  }

  function renderActions(item) {
    const id = escapeAttribute(item.id);
    const status = item.status || "visible";

    const buttons = [
      `<button type="button" class="comment-admin-action" data-admin-action="reply" data-target-id="${id}">回复</button>`,
    ];

    if (status === "visible") {
      buttons.push(`<button type="button" class="comment-admin-action" data-admin-action="hide" data-target-id="${id}">隐藏</button>`);
      buttons.push(`<button type="button" class="comment-admin-action is-danger" data-admin-action="delete" data-target-id="${id}">删除</button>`);
    } else if (status === "hidden") {
      buttons.push(`<button type="button" class="comment-admin-action" data-admin-action="restore" data-target-id="${id}">恢复</button>`);
      buttons.push(`<button type="button" class="comment-admin-action is-danger" data-admin-action="delete" data-target-id="${id}">删除</button>`);
    } else if (status === "deleted") {
      buttons.push(`<button type="button" class="comment-admin-action" data-admin-action="restore" data-target-id="${id}">恢复</button>`);
    }

    return `<div class="comment-admin-actions">${buttons.join("")}</div>`;
  }

  function renderReplyBox(item) {
    const id = escapeAttribute(item.id);
    return `
      <div class="comment-admin-reply-box" data-reply-box="${id}" hidden>
        <textarea class="comment-admin-reply-input" data-reply-input="${id}" rows="3" maxlength="1000" placeholder="以站长身份回复……"></textarea>
        <div class="comment-admin-reply-box__tools">
          <button type="button" class="comment-admin-action" data-admin-action="reply-cancel" data-target-id="${id}">取消</button>
          <button type="button" class="comment-admin-action is-primary" data-admin-action="reply-submit" data-target-id="${id}">发送回复</button>
        </div>
        <div class="comment-admin-reply-box__msg" data-reply-msg="${id}" hidden></div>
      </div>
    `;
  }

  function renderPagination(root, pagination) {
    const wrap = root.querySelector("#comment-admin-pagination");
    const info = root.querySelector("#comment-admin-page-info");
    const prev = root.querySelector("#comment-admin-prev");
    const next = root.querySelector("#comment-admin-next");
    if (!wrap || !info || !prev || !next) return;

    const totalPages = pagination.totalPages || 0;
    if (totalPages <= 1) {
      wrap.hidden = true;
      return;
    }

    wrap.hidden = false;
    info.textContent = `${pagination.page || 1} / ${totalPages}（共 ${pagination.total || 0} 个线程）`;
    prev.disabled = (pagination.page || 1) <= 1;
    next.disabled = (pagination.page || 1) >= totalPages;
  }

  // ============================================================
  // 回复 / 状态变更
  // ============================================================
  function toggleReplyBox(root, id) {
    if (state.replyingTo === id) {
      closeReplyBox(root);
      return;
    }
    closeReplyBox(root);
    state.replyingTo = id;
    const box = root.querySelector(`[data-reply-box="${cssEscape(id)}"]`);
    if (box) {
      box.hidden = false;
      const input = box.querySelector(`[data-reply-input="${cssEscape(id)}"]`);
      input?.focus();
    }
  }

  function closeReplyBox(root) {
    if (!state.replyingTo) return;
    const id = state.replyingTo;
    const box = root.querySelector(`[data-reply-box="${cssEscape(id)}"]`);
    if (box) box.hidden = true;
    state.replyingTo = null;
  }

  async function submitReply(root, id) {
    const box = root.querySelector(`[data-reply-box="${cssEscape(id)}"]`);
    const input = box?.querySelector(`[data-reply-input="${cssEscape(id)}"]`);
    const msg = box?.querySelector(`[data-reply-msg="${cssEscape(id)}"]`);
    if (!input) return;

    const content = (input.value || "").trim();
    if (!content) {
      showMessage(msg, "回复内容不能为空。", "error");
      return;
    }

    showMessage(msg, "正在发送……", "info");
    try {
      await adminFetch(`/api/admin/comments/${encodeURIComponent(id)}/reply`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      hideMessage(msg);
      await loadComments(root, state.page);
    } catch (error) {
      if (error.status === 401) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        exitPanel(root, "登录已过期，请重新登录。");
        return;
      }
      showMessage(msg, error.message || "回复失败。", "error");
    }
  }

  async function updateStatus(root, id, nextStatus) {
    try {
      await adminFetch(`/api/admin/comments/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadComments(root, state.page);
    } catch (error) {
      if (error.status === 401) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        exitPanel(root, "登录已过期，请重新登录。");
        return;
      }
      alert(error.message || "操作失败。");
    }
  }

  // ============================================================
  // 工具
  // ============================================================
  async function adminFetch(path, options = {}) {
    const token = getStoredAdminToken();
    if (!token) {
      const err = new Error("请先登录管理员后台。");
      err.status = 0;
      throw err;
    }

    const res = await fetch(`${COMMENT_API_BASE}${path}`, {
      cache: "no-cache",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    const result = await res.json().catch(() => null);

    if (!res.ok || !result?.ok) {
      console.warn("[admin]", result?.message || `请求失败：${res.status}`);
      const err = new Error(result?.message || `请求失败：${res.status}`);
      err.status = res.status;
      throw err;
    }
    return result;
  }

  function getStoredAdminToken() {
    return normalizeAdminToken(sessionStorage.getItem(ADMIN_TOKEN_KEY) || "");
  }

  function normalizeAdminToken(value) {
    const token = String(value || "").trim();
    return INVALID_ADMIN_TOKENS.has(token) ? "" : token;
  }

  function isAdminRole(item) {
    return item?.role === "admin" || item?.is_admin === 1 || item?.is_admin === true;
  }

  function showMessage(el, text, type) {
    if (!el) return;
    el.hidden = false;
    el.className = `${el.classList.contains("comment-admin-reply-box__msg") ? "comment-admin-reply-box__msg" : "comment-admin-message"} is-${type}`;
    el.textContent = text;
  }

  function hideMessage(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function formatContent(value) {
    return escapeHTML(value || "").replace(/\n/g, "<br>");
  }

  function formatDate(value) {
    if (!value) return "";
    const normalized = String(value).includes("T") ? value : String(value).replace(" ", "T") + "Z";
    const t = new Date(normalized).getTime();
    if (Number.isNaN(t)) return String(value).slice(0, 19);
    return new Date(t).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function escapeAttribute(value) {
    return escapeHTML(value).replace(/`/g, "&#96;");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCommentAdminPage, { once: true });
  } else {
    initCommentAdminPage();
  }
})();
