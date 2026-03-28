(function initVptShellNamespace() {
  const VPT = (window.VPT = window.VPT || {});

  function initShell(options = {}) {
    const body = document.body;
    const toggle = document.querySelector("[data-shell-toggle]");
    const sidebar = document.querySelector("[data-shell-sidebar]");
    const backdrop = document.querySelector("[data-shell-backdrop]");
    const navItems = Array.from(document.querySelectorAll(".nav-item"));
    const persistKey = options.persistKey || "vpt.shell.collapsed";
    const mobileMedia = window.matchMedia("(max-width: 900px)");

    if (!body || !toggle || !sidebar) {
      return {
        closeDrawer() {},
        setActiveSection() {},
      };
    }

    let collapsed = false;
    try {
      collapsed = window.localStorage.getItem(persistKey) === "1";
    } catch (_err) {
      collapsed = false;
    }

    function isMobile() {
      return mobileMedia.matches;
    }

    function setActiveSection(section) {
      const current = String(section || "").trim().toLowerCase();
      navItems.forEach((item) => {
        const view = String(item.dataset.view || item.dataset.page || "").trim().toLowerCase();
        item.classList.toggle("active", Boolean(current) && view === current);
      });
    }

    function persistCollapsedState() {
      try {
        window.localStorage.setItem(persistKey, collapsed ? "1" : "0");
      } catch (_err) {
        // Ignore storage failures; the shell still works for the current session.
      }
    }

    function closeDrawer() {
      body.classList.remove("shell-drawer-open");
      syncShellState();
    }

    function openDrawer() {
      body.classList.add("shell-drawer-open");
      syncShellState();
    }

    function setCollapsed(nextValue, opts = {}) {
      collapsed = Boolean(nextValue);
      if (opts.persist !== false) {
        persistCollapsedState();
      }
      syncShellState();
    }

    function syncShellState() {
      const mobile = isMobile();
      const drawerOpen = body.classList.contains("shell-drawer-open");
      const desktopExpanded = !mobile && !collapsed;

      body.classList.toggle("shell-mobile", mobile);
      body.classList.toggle("shell-collapsed", !mobile && collapsed);
      if (!mobile) {
        body.classList.remove("shell-drawer-open");
      }

      toggle.setAttribute("aria-expanded", mobile ? String(drawerOpen) : String(desktopExpanded));
      toggle.setAttribute(
        "aria-label",
        mobile
          ? drawerOpen
            ? "Close navigation"
            : "Open navigation"
          : collapsed
            ? "Expand navigation"
            : "Collapse navigation"
      );

      if (backdrop) {
        backdrop.setAttribute("aria-hidden", mobile && drawerOpen ? "false" : "true");
      }
    }

    toggle.addEventListener("click", () => {
      if (isMobile()) {
        if (body.classList.contains("shell-drawer-open")) {
          closeDrawer();
        } else {
          openDrawer();
        }
        return;
      }
      setCollapsed(!collapsed);
    });

    if (backdrop) {
      backdrop.addEventListener("click", () => {
        closeDrawer();
      });
    }

    navItems.forEach((item) => {
      item.addEventListener("click", () => {
        if (isMobile()) {
          closeDrawer();
        }
      });
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && body.classList.contains("shell-drawer-open")) {
        closeDrawer();
      }
    });

    mobileMedia.addEventListener("change", () => {
      syncShellState();
    });

    setActiveSection(options.currentSection || "");
    syncShellState();

    return {
      closeDrawer,
      setActiveSection,
      setCollapsed,
    };
  }

  VPT.shell = {
    initShell,
  };
})();
