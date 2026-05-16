/* cookie-consent.js — LGPD-compliant essential-cookie notice
   Load at end of <body>. Auto-dismissed after acceptance; stored in localStorage. */
(function () {
  if (localStorage.getItem("cookie_consent") === "1") return;

  var banner = document.createElement("div");
  banner.id = "cookieBanner";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Aviso de cookies");
  banner.innerHTML =
    '<span>Este site usa <strong>cookies essenciais</strong> de login e o <strong>GoatCounter Analytics</strong> (sem cookies, sem dados pessoais) para medir acessos. ' +
    'Saiba mais na nossa <a href="privacidade.html">Política de Privacidade</a>.</span>' +
    '<button id="cookieAcceptBtn" aria-label="Fechar aviso de cookies">Entendi</button>';

  var style = document.createElement("style");
  style.textContent =
    "#cookieBanner{position:fixed;bottom:0;left:0;right:0;z-index:9999;" +
    "background:rgba(22,37,58,0.97);color:rgba(255,255,255,0.9);backdrop-filter:blur(8px);" +
    "display:flex;align-items:center;justify-content:space-between;gap:16px;" +
    "padding:14px 24px;font-family:'Inter',sans-serif;font-size:13.5px;line-height:1.6;" +
    "box-shadow:0 -4px 24px rgba(0,0,0,0.22);}" +
    "#cookieBanner a{color:#d8c7a1;text-decoration:underline;}" +
    "#cookieBanner a:hover{color:#fff;}" +
    "#cookieAcceptBtn{flex-shrink:0;background:#d8c7a1;color:#1d3557;border:none;border-radius:8px;" +
    "padding:8px 20px;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:.5px;}" +
    "#cookieAcceptBtn:hover{background:#c9b48a;}" +
    "@media(max-width:600px){#cookieBanner{flex-direction:column;align-items:flex-start;padding:16px 18px;}" +
    "#cookieAcceptBtn{width:100%;text-align:center;padding:10px;}}";

  document.head.appendChild(style);
  document.body.appendChild(banner);

  document.getElementById("cookieAcceptBtn").addEventListener("click", function () {
    localStorage.setItem("cookie_consent", "1");
    banner.style.transition = "opacity 0.3s";
    banner.style.opacity = "0";
    setTimeout(function () { banner.remove(); }, 320);
  });
})();
