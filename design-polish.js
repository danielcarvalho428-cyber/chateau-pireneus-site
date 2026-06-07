(function () {
  const WA_URL = "https://wa.me/5562998167654";
  const IG_URL = "https://www.instagram.com/chateaupireneus?igsh=MXM4MDV3bmFmanZjag==";
  const MAP_URL = "https://www.google.com/maps/place/Chateau+Pireneus/@-15.850463,-48.9506312,17z/data=!3m1!4b1!4m9!3m8!1s0x935c6d77cfd0e945:0x11648adb21bd470a!5m2!4m1!1i2!8m2!3d-15.8504682!4d-48.9460178!16s%2Fg%2F11t4x3fkbm";

  const suites = [
    { slug: "aurora", name: "Suite Aurora", img: "site/public/suites/aurora/aurora1.jpeg", small: "Romantica · Cama king", nightly: "R$ 520", total: "R$ 1.120", calc: "R$ 520 x 2 noites" },
    { slug: "divino", name: "Suite do Divino", img: "site/public/suites/divino/divino1.jpeg", small: "Conforto · Ar-condicionado", nightly: "R$ 480", total: "R$ 1.040", calc: "R$ 480 x 2 noites" },
    { slug: "cavalhadas", name: "Suite das Cavalhadas", img: "site/public/suites/cavalhadas/cavalhadas1.jpeg", small: "Vista serra · Varanda", nightly: "R$ 540", total: "R$ 1.160", calc: "R$ 540 x 2 noites" },
    { slug: "rosario", name: "Suite do Rosario", img: "site/public/suites/rosario/rosario1.jpeg", small: "Cama queen · Vista jardim", nightly: "R$ 460", total: "R$ 1.000", calc: "R$ 460 x 2 noites" },
    { slug: "bonfim", name: "Suite do Bonfim", img: "site/public/suites/bonfim/bonfim1.jpeg", small: "Essencial · Aconchegante", nightly: "R$ 420", total: "R$ 920", calc: "R$ 420 x 2 noites" }
  ];

  function roomFromPath() {
    const name = location.pathname.split("/").pop().replace(".html", "");
    const match = name.match(/^suite-(.+)$/);
    return match ? match[1] : null;
  }

  function realBookingHref(slug) {
    return `suite.html?room=${encodeURIComponent(slug)}#reservaSection`;
  }

  function setExternalLinks() {
    document.querySelectorAll(".instagram-btn").forEach((link) => {
      link.href = IG_URL;
      link.target = "_blank";
      link.rel = "noopener";
      if (!link.getAttribute("aria-label")) link.setAttribute("aria-label", "Instagram");
    });
  }

  function ensureMenu() {
    if (document.getElementById("designSideMenu")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "designMenuBackdrop";
    backdrop.className = "design-menu-backdrop";

    const menu = document.createElement("nav");
    menu.id = "designSideMenu";
    menu.className = "design-side-menu";
    menu.setAttribute("aria-label", "Menu");
    menu.innerHTML = `
      <a href="index.html">Home</a>
      <a href="index.html#welcome">A pousada</a>
      <a href="acomodacoes.html">Acomodações</a>
      <a href="booking.html">Reservar</a>
      <a href="index.html#piri">Conheça Piri</a>
      <hr>
      <a href="login.html">Login / Criar Conta</a>
      <a href="dashboard.html">Minha área</a>
      <hr>
      <a href="${WA_URL}" target="_blank" rel="noopener">Entre em contato</a>
      <a href="${MAP_URL}" target="_blank" rel="noopener">Mapa e Localização</a>
      <a href="policies.html">Políticas da Pousada</a>
      <a href="privacidade.html">Política de Privacidade</a>
    `;

    document.body.append(backdrop, menu);

    function toggle(open) {
      backdrop.classList.toggle("open", open);
      menu.classList.toggle("open", open);
      document.body.classList.toggle("menu-open", open);
    }

    backdrop.addEventListener("click", () => toggle(false));
    menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => toggle(false)));
    document.querySelectorAll(".menu-button").forEach((button) => {
      button.type = "button";
      button.setAttribute("aria-label", "Abrir menu");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        toggle(!menu.classList.contains("open"));
      });
    });
  }

  function appendFooterLegalLinks() {
    document.querySelectorAll(".footer-contact").forEach((footer) => {
      if (footer.querySelector(".footer-legal-links")) return;
      const legal = document.createElement("div");
      legal.className = "footer-legal-links";
      legal.innerHTML = '<a href="policies.html">Políticas da Pousada</a><a href="privacidade.html">Política de Privacidade</a>';
      footer.appendChild(legal);
    });
  }

  function initBookingMockup() {
    const cards = Array.from(document.querySelectorAll(".pick-card"));
    if (!cards.length) return;

    let selected = Math.max(0, cards.findIndex((card) => card.classList.contains("selected")));

    function syncSummary(index) {
      selected = index;
      cards.forEach((card, idx) => card.classList.toggle("selected", idx === selected));
      const suite = suites[selected];
      const photo = document.querySelector(".sum-photo img");
      const name = document.querySelector(".sum-photo .name");
      const small = document.querySelector(".sum-photo .small");
      const rows = document.querySelectorAll(".sum-breakdown .sum-br");
      if (photo) photo.src = suite.img;
      if (name) name.textContent = suite.name;
      if (small) small.textContent = suite.small;
      if (rows[0]) rows[0].innerHTML = `<span>${suite.calc}</span><span>${suite.total === "R$ 920" ? "R$ 840" : suite.total.replace(".", ".")}</span>`;
      if (rows[2]) rows[2].innerHTML = "<span>Cafe da manha (2 pessoas)</span><span>incluso</span>";
      if (rows[3]) rows[3].innerHTML = `<span>Total</span><span>${suite.total}</span>`;
    }

    function goToLiveBooking() {
      location.href = realBookingHref(suites[selected].slug);
    }

    cards.forEach((card, idx) => {
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.addEventListener("click", () => syncSummary(idx));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          syncSummary(idx);
        }
      });
    });

    document.querySelector(".btn-next")?.addEventListener("click", goToLiveBooking);
    document.querySelector(".sum-cta")?.addEventListener("click", goToLiveBooking);
    document.querySelector(".btn-back")?.addEventListener("click", () => { location.href = "index.html"; });
    syncSummary(selected);
  }

  function wireSuiteReserveButtons() {
    const room = roomFromPath();
    if (!room) return;
    document.querySelectorAll(".bk-cta, .mb-btn").forEach((button) => {
      button.type = "button";
      button.onclick = null;
      button.addEventListener("click", () => { location.href = realBookingHref(room); });
    });
  }

  function wireSearchBar() {
    document.querySelectorAll(".sb-search-btn").forEach((button) => {
      button.type = "button";
      button.addEventListener("click", () => { location.href = "booking.html"; });
    });
  }

  function enhanceImages() {
    document.querySelectorAll("img").forEach((img, index) => {
      if (!img.hasAttribute("decoding")) img.setAttribute("decoding", "async");
      if (index > 0 && !img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    setExternalLinks();
    ensureMenu();
    appendFooterLegalLinks();
    initBookingMockup();
    wireSuiteReserveButtons();
    wireSearchBar();
    enhanceImages();
  });
})();
