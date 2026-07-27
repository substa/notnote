(() => {
  "use strict";

  let appearance = {};
  try {
    const stored = (key) => JSON.parse(localStorage.getItem(key)) || {};
    appearance = {
      ...stored("notnote-markdown-settings-v1"),
      ...stored("notnote-bootstrap-appearance-v1"),
    };
  } catch {}

  const theme = ["light", "dark", "system"].includes(appearance.theme)
    ? appearance.theme
    : "system";
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("theme-dark", dark);
  root.classList.toggle("theme-system", theme === "system");
  root.style.colorScheme = dark ? "dark" : "light";
  if (/^#[0-9a-f]{6}$/i.test(appearance.accentColor || ""))
    root.style.setProperty("--accent", appearance.accentColor);
  document
    .querySelector("meta[name=theme-color]")
    ?.setAttribute("content", dark ? "#282725" : "#fdfcfb");
})();
