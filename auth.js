/* auth.js — shared Supabase client + header auth UI + utilities
   Load AFTER: supabase UMD CDN script + supabase-config.js
   Provides: window.supabaseClient, window.toggleMenu, window.logout, window.getLoginHref */

(function () {
  // ── Single shared Supabase client ──────────────────────────────
  window.supabaseClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

  // ── Utilities ──────────────────────────────────────────────────
  function getLoginHref() {
    return "login.html?return_to=" + encodeURIComponent(
      window.location.pathname + window.location.search + window.location.hash
    );
  }
  window.getLoginHref = getLoginHref;

  function toggleMenu(forceOpen) {
    var menu     = document.getElementById("sideMenu");
    var backdrop = document.getElementById("backdrop");
    if (!menu) return;
    var open = (forceOpen === true) || (forceOpen === undefined && !menu.classList.contains("open"));
    menu.classList.toggle("open", open);
    if (backdrop) backdrop.classList.toggle("open", open);
  }
  window.toggleMenu = toggleMenu;

  async function logout() {
    try { await window.supabaseClient.auth.signOut(); } catch (e) { console.error(e); }
    window.location.href = "index.html";
  }
  window.logout = logout;

  // ── Header auth UI ─────────────────────────────────────────────
  // Supports two HTML patterns used across pages:
  //   Pattern A: accountActionBtn + logoutBtnHeader + sideAuthLinks (index, pousada, policies)
  //   Pattern B: headerLoginBtn + headerDashboardBtn + headerLogoutBtn (acomodacoes, suite, booking)
  function applyAuthUI(session) {
    var user = session ? session.user : null;

    // Pattern A
    var accountActionBtn = document.getElementById("accountActionBtn");
    var logoutBtnHeader  = document.getElementById("logoutBtnHeader");
    var sideAuthLinks    = document.getElementById("sideAuthLinks");

    if (accountActionBtn) {
      accountActionBtn.textContent = user ? "MINHA ÁREA" : "ENTRAR";
      accountActionBtn.href        = user ? "dashboard.html" : getLoginHref();
    }
    if (logoutBtnHeader) logoutBtnHeader.classList.toggle("hidden", !user);
    if (sideAuthLinks) {
      sideAuthLinks.innerHTML = user
        ? '<a href="dashboard.html" onclick="toggleMenu(false)">Minha área</a><button type="button" onclick="logout();toggleMenu(false)">Sair</button>'
        : '<a href="' + getLoginHref() + '" onclick="toggleMenu(false)">Login / Criar Conta</a>';
    }

    // Pattern B
    var headerLoginBtn     = document.getElementById("headerLoginBtn");
    var headerDashboardBtn = document.getElementById("headerDashboardBtn");
    var headerLogoutBtn    = document.getElementById("headerLogoutBtn");
    var sideLoggedOut      = document.getElementById("sideLoggedOut");
    var sideLoggedIn       = document.getElementById("sideLoggedIn");
    var sideLoginLink      = document.getElementById("sideLoginLink");

    if (headerLoginBtn) {
      headerLoginBtn.style.display = user ? "none" : "inline-flex";
      headerLoginBtn.href          = getLoginHref();
    }
    if (headerDashboardBtn) headerDashboardBtn.style.display = user ? "inline-flex" : "none";
    if (headerLogoutBtn)    headerLogoutBtn.style.display    = user ? "inline-flex" : "none";
    if (sideLoggedOut)      sideLoggedOut.style.display      = user ? "none"        : "block";
    if (sideLoggedIn)       sideLoggedIn.style.display       = user ? "block"       : "none";
    if (sideLoginLink)      sideLoginLink.href               = getLoginHref();
  }

  // ── Scroll header ──────────────────────────────────────────────
  function initScrollHeader() {
    var topHeader = document.getElementById("topHeader");
    if (!topHeader) return;
    function onScroll() { topHeader.classList.toggle("solid", window.scrollY > 40); }
    window.addEventListener("scroll", onScroll);
    onScroll();
  }

  // ── Init on DOM ready ──────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    initScrollHeader();

    // Auth state
    window.supabaseClient.auth.getSession().then(function (res) {
      applyAuthUI(res.data ? res.data.session : null);
    });
    window.supabaseClient.auth.onAuthStateChange(function (_e, s) { applyAuthUI(s); });

    // Logout buttons
    ["logoutBtnHeader", "headerLogoutBtn", "logout-btn-top", "logout-btn"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", logout);
    });
    var sideLogoutBtn = document.getElementById("sideLogoutBtn");
    if (sideLogoutBtn) sideLogoutBtn.addEventListener("click", function () { toggleMenu(false); logout(); });

    // Hamburger / backdrop
    var menuBtn  = document.getElementById("menuBtn");
    var backdrop = document.getElementById("backdrop");
    if (menuBtn)  menuBtn.addEventListener("click",  function () { toggleMenu(); });
    if (backdrop) backdrop.addEventListener("click", function () { toggleMenu(false); });

    // WhatsApp number centralization — replace hardcoded number in all static links
    if (window.WA_NUMBER) {
      document.querySelectorAll('a[href*="wa.me/"]').forEach(function (a) {
        a.href = a.href.replace(/wa\.me\/\d+/, "wa.me/" + window.WA_NUMBER);
      });
    }
  });
})();
