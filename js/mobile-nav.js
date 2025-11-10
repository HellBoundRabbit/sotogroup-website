(function() {
  const NAV_ATTRIBUTE = "data-soto-nav";
  const NAV_TOGGLE_ATTRIBUTE = "data-soto-nav-toggle";
  const NAV_LINKS_ATTRIBUTE = "data-soto-nav-links";

  function closeNav(header, toggle) {
    if (header.classList.contains("nav-open")) {
      header.classList.remove("nav-open");
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
      }
    }
  }

  function initHeader(header) {
    if (!header || header.dataset.navInitialised === "true") {
      return;
    }
    const toggle = header.querySelector("[" + NAV_TOGGLE_ATTRIBUTE + "]");
    const nav = header.querySelector("[" + NAV_LINKS_ATTRIBUTE + "]");

    if (!toggle || !nav) {
      return;
    }

    header.dataset.navInitialised = "true";
    toggle.setAttribute("aria-expanded", "false");

    toggle.addEventListener("click", function(event) {
      event.stopPropagation();
      const expanded = header.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    });

    nav.querySelectorAll("a").forEach(function(link) {
      link.addEventListener("click", function() {
        closeNav(header, toggle);
      });
    });

    document.addEventListener("click", function(event) {
      if (!header.contains(event.target)) {
        closeNav(header, toggle);
      }
    });

    document.addEventListener("keydown", function(event) {
      if (event.key === "Escape") {
        closeNav(header, toggle);
      }
    });

    window.addEventListener("resize", function() {
      if (window.innerWidth > 960) {
        closeNav(header, toggle);
      }
    });
  }

  function initialise() {
    document
        .querySelectorAll("[" + NAV_ATTRIBUTE + "]")
        .forEach(initHeader);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialise);
  } else {
    initialise();
  }
})();

