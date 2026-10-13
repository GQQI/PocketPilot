(function () {
  const root = document.documentElement;
  const nav = document.getElementById("nav");
  const langBtn = document.getElementById("lang");
  const themeBtn = document.getElementById("theme");
  const menuBtn = document.getElementById("menu");
  const drawer = document.getElementById("drawer");
  const bar = document.getElementById("progress");

  const lang = localStorage.getItem("pp-site-lang") || "zh";
  const theme = localStorage.getItem("pp-site-theme") || "light";

  function applyLang(next) {
    root.lang = next === "en" ? "en" : "zh-CN";
    document.querySelectorAll("[data-zh]").forEach((el) => {
      el.textContent = el.getAttribute(next === "en" ? "data-en" : "data-zh");
    });
    if (langBtn) langBtn.textContent = next === "en" ? "中" : "EN";
    document.title = next === "en" ? "PocketPilot" : "PocketPilot · 口袋领航";
    localStorage.setItem("pp-site-lang", next);
  }

  function applyTheme(next) {
    root.dataset.theme = next;
    if (themeBtn) themeBtn.textContent = next === "dark" ? "☀" : "☾";
    localStorage.setItem("pp-site-theme", next);
  }

  applyLang(lang);
  applyTheme(theme);

  langBtn?.addEventListener("click", () => applyLang(root.lang === "en" ? "zh" : "en"));
  themeBtn?.addEventListener("click", () => applyTheme(root.dataset.theme === "dark" ? "light" : "dark"));
  menuBtn?.addEventListener("click", () => {
    drawer?.classList.toggle("open");
    nav?.classList.toggle("open");
  });
  drawer?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => {
    drawer.classList.remove("open");
    nav?.classList.remove("open");
  }));

  const onScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
    nav?.classList.toggle("scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
})();
