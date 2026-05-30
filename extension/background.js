// Responde perguntas dos content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getTabId') {
    sendResponse({ tabId: sender.tab.id });
    return;
  }

  if (msg.action === 'getBet365Games') {
    chrome.tabs.query({ url: '*://*.bet365.com/*' }, (tabs) => {
      if (!tabs.length) { sendResponse({ games: [] }); return; }
      const keys = tabs.map(t => `radar_${t.id}`);
      chrome.storage.local.get(keys, (stored) => {
        const games = tabs
          .map(t => ({ tabId: t.id, data: stored[`radar_${t.id}`] || null }))
          .filter(g => g.data);
        sendResponse({ games });
      });
    });
    return true;
  }

  if (msg.action === 'openBet365') {
    const teams = msg.teams;
    const url   = 'https://www.bet365.com/#/IP';

    const afterOpen = (tabId) => {
      if (!teams) return;
      // Aguarda o tab carregar e envia as equipas para o scraper navegar
      const listener = (tid, changeInfo) => {
        if (tid !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        // Retry: tenta enviar até 6x com intervalos crescentes (SPA precisa de tempo)
        let attempt = 0;
        const trySend = () => {
          chrome.tabs.sendMessage(tabId, { action: 'navigateToGame', teams }, (res) => {
            if (chrome.runtime.lastError || !res?.ok) {
              if (attempt++ < 5) setTimeout(trySend, 2000);
            }
          });
        };
        setTimeout(trySend, 4500);
      };
      chrome.tabs.onUpdated.addListener(listener);
    };

    chrome.windows.create({ url, incognito: true }, (win) => {
      if (chrome.runtime.lastError) {
        chrome.tabs.create({ url }, (tab) => afterOpen(tab.id));
      } else {
        afterOpen(win.tabs[0].id);
      }
    });
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'focusTab') {
    chrome.tabs.get(msg.tabId, (tab) => {
      if (chrome.runtime.lastError) { sendResponse({ ok: false }); return; }
      chrome.tabs.update(msg.tabId, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
      sendResponse({ ok: true });
    });
    return true;
  }
});

// Limpa storage quando aba da bet365 fecha
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`radar_${tabId}`);
});

// Monitora navegação: quando uma URL de stream da rushflows carrega,
// envia showRadar automaticamente (cobre popup + aba normal)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url?.includes('rushflows.vip/watch/')) return;

  // Aguarda o content script inicializar e então envia showRadar
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { action: 'showRadar' }).catch(() => {
      // Content script ainda não carregou — injeta manualmente
      chrome.scripting.insertCSS({ target: { tabId }, files: ['radar.css'] })
        .then(() => chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }))
        .then(() => setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { action: 'showRadar' }).catch(() => {});
        }, 400))
        .catch(() => {});
    });
  }, 600);
});

// Clique no ícone → toggle manual em qualquer site que não seja bet365
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || tab.url.includes('bet365.com')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleRadar' });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['radar.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    setTimeout(() => chrome.tabs.sendMessage(tab.id, { action: 'toggleRadar' }).catch(() => {}), 200);
  }
});
