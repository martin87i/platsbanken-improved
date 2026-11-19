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

  // Öppna tilläggshanteraren.
  // Chrome: tabs.create kan öppna chrome://extensions (kräver ingen "tabs"-behörighet). window.open blockeras.
  // Firefox: tillägg får inte öppna about:addons, så adressen kopieras och användaren klistrar in den i adressfältet.
  manageBtn.addEventListener('click', async () => {
    const isFirefox =
      typeof InstallTrigger !== 'undefined' || navigator.userAgent.includes('Firefox');
    if (!isFirefox) {
      try {
        await api.tabs.create({ url: 'chrome://extensions/?id=' + api.runtime.id });
        window.close();
        return;
      } catch {
        try { await api.tabs.create({ url: 'chrome://extensions/' }); window.close(); return; } catch {}
      }
    }
    const label = manageBtn.querySelector('.label') || manageBtn;
    const old = label.textContent;
    let copied = false;
    try { await navigator.clipboard.writeText(isFirefox ? 'about:addons' : 'chrome://extensions/'); copied = true; } catch {}
    label.textContent = copied
      ? 'Kopierat! Klistra in i adressfältet'
      : 'Skriv ' + (isFirefox ? 'about:addons' : 'chrome://extensions') + ' i adressfältet';
    setTimeout(() => { label.textContent = old; }, 4000);
  });

  // Donera-knappen
  donateBtn.addEventListener('click', () => {
    window.open('https://buymeacoffee.com/lowkeylokee', '_blank', 'noopener');
  });
})();
