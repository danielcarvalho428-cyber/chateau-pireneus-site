/* Shared Supabase client + header auth UI + utilities.
   Load after the Supabase UMD script and supabase-config.js. */

(function () {
  // GoatCounter Analytics — free, cookie-free, no personal data, LGPD-compliant
  ;(function() {
    var skip = /\/(admin|dashboard|ficha|login|register|signup)/.test(window.location.pathname)
    if (skip) return
    var s = document.createElement("script")
    s.async = true
    s.dataset.goatcounter = "https://chateaupireneus.goatcounter.com/count"
    s.src = "//gc.zgo.at/count.js"
    document.head.appendChild(s)
  })()

  window.supabaseClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

  function sanitizeReturnTo(value, fallback) {
    var safeFallback = fallback || "dashboard.html";
    if (!value) return safeFallback;
    if (value.indexOf("\\") !== -1) return safeFallback;
    if (value.indexOf("//") === 0) return safeFallback;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return safeFallback;

    try {
      var url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin) return safeFallback;
      return url.pathname + url.search + url.hash;
    } catch (_err) {
      return safeFallback;
    }
  }
  window.sanitizeReturnTo = sanitizeReturnTo;

  function getReturnTo(fallback) {
    var params = new URLSearchParams(window.location.search);
    return sanitizeReturnTo(params.get("return_to"), fallback || "dashboard.html");
  }
  window.getReturnTo = getReturnTo;

  function getCurrentPath() {
    return window.location.pathname + window.location.search + window.location.hash;
  }

  function buildLoginHref(returnTo) {
    var safeReturnTo = sanitizeReturnTo(returnTo || getCurrentPath(), "dashboard.html");
    return "login.html?return_to=" + encodeURIComponent(safeReturnTo);
  }
  window.buildLoginHref = buildLoginHref;
  window.getLoginHref = buildLoginHref;

  function buildRegisterHref(returnTo) {
    var safeReturnTo = sanitizeReturnTo(returnTo || getCurrentPath(), "dashboard.html");
    return "register.html?return_to=" + encodeURIComponent(safeReturnTo);
  }
  window.buildRegisterHref = buildRegisterHref;

  function redirectToLogin(returnTo) {
    window.location.href = buildLoginHref(returnTo || getCurrentPath());
  }
  window.redirectToLogin = redirectToLogin;

  async function isCurrentUserAdmin() {
    try {
      var result = await window.supabaseClient.rpc("is_current_user_admin");
      if (result.error) throw result.error;
      return result.data === true;
    } catch (err) {
      console.error("Admin check failed:", err);
      return false;
    }
  }
  window.isCurrentUserAdmin = isCurrentUserAdmin;

  function toggleMenu(forceOpen) {
    var menu = document.getElementById("sideMenu");
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

  function setAreaLinks(isAdmin) {
    var areaHref = isAdmin ? "admin.html" : "dashboard.html";
    var areaLabel = isAdmin ? "ADMIN" : "MINHA ÁREA";

    var accountActionBtn = document.getElementById("accountActionBtn");
    var sideAuthLinks = document.getElementById("sideAuthLinks");
    var headerDashboardBtn = document.getElementById("headerDashboardBtn");
    var sideLoggedIn = document.getElementById("sideLoggedIn");
    var sideDashboardLink = document.getElementById("sideDashboardLink");

    if (accountActionBtn && accountActionBtn.dataset.loggedIn === "true") {
      accountActionBtn.textContent = areaLabel;
      accountActionBtn.href = areaHref;
    }
    if (sideAuthLinks && sideAuthLinks.dataset.loggedIn === "true") {
      sideAuthLinks.innerHTML =
        '<a href="' + areaHref + '" onclick="toggleMenu(false)">' +
        (isAdmin ? "Admin" : "Minha área") +
        '</a><button type="button" onclick="logout();toggleMenu(false)">Sair</button>';
    }
    if (headerDashboardBtn) {
      headerDashboardBtn.href = areaHref;
      headerDashboardBtn.textContent = areaLabel;
    }
    if (sideLoggedIn) {
      var links = sideLoggedIn.querySelectorAll('a[href="dashboard.html"], a[href="admin.html"]');
      links.forEach(function (link) {
        link.href = areaHref;
        link.textContent = isAdmin ? "Admin" : "Minha área";
      });
    }
    if (sideDashboardLink) {
      sideDashboardLink.href = areaHref;
      sideDashboardLink.textContent = isAdmin ? "Painel admin" : "Minha área";
    }
  }

  function applyAuthUI(session) {
    var user = session ? session.user : null;

    var accountActionBtn = document.getElementById("accountActionBtn");
    var logoutBtnHeader = document.getElementById("logoutBtnHeader");
    var sideAuthLinks = document.getElementById("sideAuthLinks");

    if (accountActionBtn) {
      accountActionBtn.dataset.loggedIn = user ? "true" : "false";
      accountActionBtn.textContent = user ? "MINHA ÁREA" : "ENTRAR";
      accountActionBtn.href = user ? "dashboard.html" : buildLoginHref();
    }
    if (logoutBtnHeader) logoutBtnHeader.classList.toggle("hidden", !user);
    if (sideAuthLinks) {
      sideAuthLinks.dataset.loggedIn = user ? "true" : "false";
      sideAuthLinks.innerHTML = user
        ? '<a href="dashboard.html" onclick="toggleMenu(false)">Minha área</a><button type="button" onclick="logout();toggleMenu(false)">Sair</button>'
        : '<a href="' + buildLoginHref() + '" onclick="toggleMenu(false)">Login / Criar Conta</a>';
    }

    var headerLoginBtn = document.getElementById("headerLoginBtn");
    var headerDashboardBtn = document.getElementById("headerDashboardBtn");
    var headerLogoutBtn = document.getElementById("headerLogoutBtn");
    var sideLoggedOut = document.getElementById("sideLoggedOut");
    var sideLoggedIn = document.getElementById("sideLoggedIn");
    var sideLoginLink = document.getElementById("sideLoginLink");
    var headerLoggedOutLinks = document.getElementById("headerLoggedOutLinks");
    var headerLoggedInLinks = document.getElementById("headerLoggedInLinks");
    var sideLoggedOutLinks = document.getElementById("sideLoggedOutLinks");
    var sideLoggedInLinks = document.getElementById("sideLoggedInLinks");
    var registerHeaderBtn = document.getElementById("registerHeaderBtn");
    var sideRegisterLink = document.getElementById("sideRegisterLink");

    if (headerLoginBtn) {
      headerLoginBtn.style.display = user ? "none" : "inline-flex";
      headerLoginBtn.href = buildLoginHref();
    }
    if (headerDashboardBtn) {
      headerDashboardBtn.style.display = user ? "inline-flex" : "none";
      headerDashboardBtn.href = "dashboard.html";
    }
    if (headerLogoutBtn) headerLogoutBtn.style.display = user ? "inline-flex" : "none";
    if (sideLoggedOut) sideLoggedOut.style.display = user ? "none" : "block";
    if (sideLoggedIn) sideLoggedIn.style.display = user ? "block" : "none";
    if (sideLoginLink) sideLoginLink.href = buildLoginHref();
    if (headerLoggedOutLinks) headerLoggedOutLinks.classList.toggle("hidden", !!user);
    if (headerLoggedInLinks) headerLoggedInLinks.classList.toggle("hidden", !user);
    if (sideLoggedOutLinks) sideLoggedOutLinks.classList.toggle("hidden", !!user);
    if (sideLoggedInLinks) sideLoggedInLinks.classList.toggle("hidden", !user);
    if (registerHeaderBtn) registerHeaderBtn.href = buildRegisterHref();
    if (sideRegisterLink) sideRegisterLink.href = buildRegisterHref();

    if (user) isCurrentUserAdmin().then(setAreaLinks);
  }

  function initScrollHeader() {
    var topHeader = document.getElementById("topHeader");
    if (!topHeader) return;
    function onScroll() { topHeader.classList.toggle("solid", window.scrollY > 40); }
    window.addEventListener("scroll", onScroll);
    onScroll();
  }

  document.addEventListener("DOMContentLoaded", function () {
    initScrollHeader();

    window.supabaseClient.auth.getSession().then(function (res) {
      applyAuthUI(res.data ? res.data.session : null);
    });
    window.supabaseClient.auth.onAuthStateChange(function (_e, s) { applyAuthUI(s); });

    ["logoutBtnHeader", "headerLogoutBtn", "logout-btn-top", "logout-btn"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", logout);
    });
    var sideLogoutBtn = document.getElementById("sideLogoutBtn");
    if (sideLogoutBtn) sideLogoutBtn.addEventListener("click", function () { toggleMenu(false); logout(); });

    var menuBtn = document.getElementById("menuBtn");
    var backdrop = document.getElementById("backdrop");
    if (menuBtn) menuBtn.addEventListener("click", function () { toggleMenu(); });
    if (backdrop) backdrop.addEventListener("click", function () { toggleMenu(false); });

    if (window.WA_NUMBER) {
      document.querySelectorAll('a[href*="wa.me/"]').forEach(function (a) {
        a.href = a.href.replace(/wa\.me\/\d+/, "wa.me/" + window.WA_NUMBER);
      });
    }

    if (window.CONTACT_EMAIL) {
      document.querySelectorAll('a[href^="mailto:"]').forEach(function (a) {
        a.href = "mailto:" + window.CONTACT_EMAIL;
      });
    }

    document.querySelectorAll('a[target="_blank"]').forEach(function (a) {
      var rel = (a.getAttribute("rel") || "").split(/\s+/).filter(Boolean);
      if (rel.indexOf("noopener") === -1) rel.push("noopener");
      a.setAttribute("rel", rel.join(" "));
    });
  });
})();
