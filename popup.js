(() => {
  // Både Chrome och Firefox använder samma API-namn här
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const enabledToggle = document.getElementById('enabledToggle');
  const manageBtn     = document.getElementById('manageBtn');
  const donateBtn     = document.getElementById('donateBtn');

  // Läs sparat läge (default: true)
  (async () => {
    try {
      const res = await api.storage.local.get({ enabled: true });
      enabledToggle.checked = !!res.enabled;
    } catch {
      enabledToggle.checked = true; // fallback
    }
  })();

  // När användaren ändrar toggle – spara status
  enabledToggle.addEventListener('change', async () => {
    try {
      await api.storage.local.set({ enabled: enabledToggle.checked });
    } catch (err) {
      console.error('Kunde inte spara toggle-status:', err);
    }
  });

  // Öppna tilläggshanteraren – fungerar utan "tabs"-permission
  manageBtn.addEventListener('click', () => {
    const isFirefox =
      typeof InstallTrigger !== 'undefined' || navigator.userAgent.includes('Firefox');
    const url = isFirefox ? 'about:addons' : 'chrome://extensions/';
    try {
      // Försök öppna direkt i nytt fönster/flik
      window.open(url, '_blank');
    } catch {
      // Om det blockeras, öppna supportsida istället
      const help = isFirefox
        ? 'https://support.mozilla.org/kb/disable-or-remove-add-ons'
        : 'https://support.google.com/chrome_webstore/answer/2664769';
      window.open(help, '_blank');
    }
  });

  // Donera-knappen
  donateBtn.addEventListener('click', () => {
    window.open('https://buymeacoffee.com/lowkeylokee', '_blank', 'noopener');
  });
})();
