// Light / Dark / Auto, chosen per device with the switch in the top bar. Runs before the page draws, so a dark page
// never flashes light. The cookie carries the choice to the book reader, which is served from another port.
(() => {
  let theme = 'auto';
  try {
    theme = JSON.parse(localStorage.getItem('outpost.theme') ?? '"auto"');
  } catch {
    /* private mode: follow the system */
  }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else theme = 'auto';
  document.cookie = `outpost_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
})();
