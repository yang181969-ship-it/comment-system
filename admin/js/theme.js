/* ============================================================
   主题系统
   - 色相:滑块 + 8 个预设
   - 模式:light / dark / auto(跟随系统)—— 仅在调色盘面板内切换
   - 辉光:on / off(ambient glow 开关)
   - 持久化:localStorage
   ============================================================ */

(function initThemeBootstrap() {
  // 尽早应用,避免刷新时闪白屏
  const root = document.documentElement;

  // 首次访问的默认值:明亮模式 / 蓝色(色相 210)/ 关闭辉光
  if (localStorage.getItem("primary-hue") === null) localStorage.setItem("primary-hue", "210");
  if (localStorage.getItem("theme-mode")  === null) localStorage.setItem("theme-mode",  "light");
  if (localStorage.getItem("ambient-glow") === null) localStorage.setItem("ambient-glow", "off");

  const savedHue = localStorage.getItem("primary-hue");
  if (savedHue) root.style.setProperty("--primary-hue", savedHue);

  const savedMode = localStorage.getItem("theme-mode") || "auto";
  applyMode(savedMode, root);

  // 辉光开关:只有显式存 "off" 才关
  const savedGlow = localStorage.getItem("ambient-glow") === "off" ? "off" : "on";
  root.setAttribute("data-glow", savedGlow);

  // 暴露给 DOMContentLoaded 后的代码复用
  window.__applyMode = applyMode;
  window.__applyGlow = applyGlow;
})();

function applyMode(mode, root) {
  root = root || document.documentElement;
  if (mode === "auto") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", prefersDark ? "dark" : "light");
    root.setAttribute("data-theme-mode", "auto");
  } else {
    root.setAttribute("data-theme", mode);
    root.setAttribute("data-theme-mode", mode);
  }

  document.dispatchEvent(new CustomEvent("theme:change", { detail: { kind: "mode" } }));
}

function applyGlow(state, root) {
  root = root || document.documentElement;
  const normalized = state === "off" ? "off" : "on";
  root.setAttribute("data-glow", normalized);
  localStorage.setItem("ambient-glow", normalized);
  document.dispatchEvent(new CustomEvent("theme:change", { detail: { kind: "glow" } }));
}

document.addEventListener("DOMContentLoaded", () => {
  const themeToggle  = document.getElementById("theme-toggle");
  const themePanel   = document.getElementById("theme-panel");
  const hueSlider    = document.getElementById("hue-slider");
  const modeBtns     = document.querySelectorAll(".theme-mode-btn");
  const presetBtns   = document.querySelectorAll(".theme-preset");
  const glowToggle   = document.getElementById("glow-toggle");
  const root         = document.documentElement;

  if (!themeToggle || !themePanel || !hueSlider) return;

  /* ===== 初始化色相滑块显示值 ===== */
  const savedHue = localStorage.getItem("primary-hue");
  if (savedHue) hueSlider.value = savedHue;

  /* ===== 初始化模式按钮高亮 ===== */
  function syncModeActive() {
    const mode = localStorage.getItem("theme-mode") || "auto";
    modeBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.mode === mode));
  }
  syncModeActive();

  /* ===== 初始化预设颜色高亮 ===== */
  function syncPresetActive() {
    const hue = hueSlider.value;
    presetBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.hue === hue));
  }
  syncPresetActive();

  /* ===== 初始化辉光开关状态 ===== */
  function syncGlowActive() {
    if (!glowToggle) return;
    const glow = root.getAttribute("data-glow") || "on";
    glowToggle.classList.toggle("active", glow === "on");
    glowToggle.setAttribute("aria-pressed", glow === "on" ? "true" : "false");
  }
  syncGlowActive();

  /* ===== 面板开关 ===== */
  themeToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    themePanel.classList.toggle("show");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".theme-control")) {
      themePanel.classList.remove("show");
    }
  });

  /* ===== 色相滑块 ===== */
  hueSlider.addEventListener("input", (e) => {
    const hue = e.target.value;
    root.style.setProperty("--primary-hue", hue);
    localStorage.setItem("primary-hue", hue);
    syncPresetActive();
    document.dispatchEvent(new CustomEvent("theme:change", { detail: { kind: "hue" } }));
  });

  /* ===== 预设颜色点击 ===== */
  presetBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const hue = btn.dataset.hue;
      root.style.setProperty("--primary-hue", hue);
      hueSlider.value = hue;
      // 派发 input 事件,让 main.js 里 hue-picker 的反向同步逻辑更新色条 thumb 位置
      hueSlider.dispatchEvent(new Event("input", { bubbles: true }));
      localStorage.setItem("primary-hue", hue);
      syncPresetActive();
    });
  });

  /* ===== 模式按钮(面板内) ===== */
  modeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      localStorage.setItem("theme-mode", mode);
      window.__applyMode(mode);
      syncModeActive();
    });
  });

  /* ===== 辉光开关(面板内,可选) ===== */
  if (glowToggle) {
    glowToggle.addEventListener("click", () => {
      const current = root.getAttribute("data-glow") || "on";
      const next = current === "on" ? "off" : "on";
      window.__applyGlow(next);
      syncGlowActive();
    });
  }

  /* ===== 监听系统主题变化(auto 模式下实时跟随) ===== */
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if ((localStorage.getItem("theme-mode") || "auto") === "auto") {
      window.__applyMode("auto");
    }
  };
  if (mql.addEventListener) {
    mql.addEventListener("change", onSystemChange);
  } else if (mql.addListener) {
    mql.addListener(onSystemChange);
  }
});