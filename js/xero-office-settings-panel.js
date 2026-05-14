/**
 * Injects Xero expense settings into #settingsModal on office portal pages.
 * Depends on: session / getCurrentOfficeId or currentSession.officeId, Firebase globals
 * (firebaseDoc + firestore + firebaseGetDoc + firebaseUpdateDoc, or doc + db + getDoc + updateDoc),
 * window.firebase.httpsCallable + window.functions || window.firebase.functions.
 */
(function () {
  'use strict';

  function resolveOfficeId() {
    if (typeof getCurrentOfficeId === 'function') return getCurrentOfficeId();
    try {
      if (typeof currentSession !== 'undefined' && currentSession && currentSession.officeId) {
        return currentSession.officeId;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function getFunctionsInstance() {
    if (window.functions) return window.functions;
    if (window.firebase && window.firebase.functions) return window.firebase.functions;
    return null;
  }

  function getHttpsCallable() {
    return window.firebase && typeof window.firebase.httpsCallable === 'function'
      ? window.firebase.httpsCallable
      : null;
  }

  function officeRef(officeId) {
    if (window.firebaseDoc && window.firestore) {
      return window.firebaseDoc(window.firestore, 'offices', officeId);
    }
    if (window.doc && window.db) {
      return window.doc(window.db, 'offices', officeId);
    }
    return null;
  }

  async function readOffice(officeId) {
    const ref = officeRef(officeId);
    if (!ref) return {};
    const getDocFn = window.firebaseGetDoc || window.getDoc;
    if (!getDocFn) return {};
    const snap = await getDocFn(ref);
    return snap.exists() ? snap.data() : {};
  }

  async function updateOffice(officeId, data) {
    const ref = officeRef(officeId);
    if (!ref) throw new Error('No Firestore ref');
    const updateDocFn = window.firebaseUpdateDoc || window.updateDoc;
    if (!updateDocFn) throw new Error('No updateDoc');
    await updateDocFn(ref, data);
  }

  function getXeroRedirectUri() {
    return window.location.origin + '/pages/xero-callback.html';
  }

  function notify(tone, title, message) {
    if (window.uiDialogs && window.uiDialogs.showAlert) {
      window.uiDialogs.showAlert({ title: title, message: message, tone: tone });
    } else if (tone === 'danger') {
      window.alert(title + ': ' + message);
    } else {
      window.alert(title + ': ' + message);
    }
  }

  async function confirmDisconnect() {
    var opts = {
      title: 'Disconnect Xero?',
      message:
        'This office will stop sending draft bills to Xero until you connect again. Existing Xero data is not changed.',
      confirmText: 'Disconnect',
      cancelText: 'Cancel',
      tone: 'warning',
    };
    if (window.showConfirmation) return window.showConfirmation(opts);
    if (window.uiDialogs && window.uiDialogs.showConfirmation) return window.uiDialogs.showConfirmation(opts);
    return window.confirm(opts.message);
  }

  function ensureOAuthListener() {
    if (window._sotoXeroOAuthListener) return;
    window._sotoXeroOAuthListener = true;
    window.addEventListener(
      'message',
      async function (ev) {
        var d = ev.data;
        if (!d || d.source !== 'soto-xero-oauth') return;
        if (ev.origin !== window.location.origin) return;
        if (d.error) {
          if (d.error !== 'access_denied') {
            notify('warning', 'Xero', 'Xero sign-in did not complete.');
          }
          return;
        }
        if (!d.code || !d.state) return;
        var hc = getHttpsCallable();
        var fx = getFunctionsInstance();
        if (!hc || !fx) return;
        try {
          var exchange = hc(fx, 'xeroExchangeCode');
          var officeId = resolveOfficeId();
          await exchange({
            code: d.code,
            state: d.state,
            officeId: officeId,
          });
          notify('success', 'Xero', 'Xero connected. Use Sync with Xero on the Validated expenses tab to create draft bills.');
          await refresh();
        } catch (err) {
          console.error(err);
          var msg = err && err.message ? err.message : 'Could not complete Xero connection.';
          notify('danger', 'Xero', msg);
        }
      },
      false,
    );
  }

  async function refresh() {
    var officeId = resolveOfficeId();
    var toggle = document.getElementById('xeroExpenseIntegrationToggle');
    var statusEl = document.getElementById('xeroConnectionStatus');
    var connectBtn = document.getElementById('xeroConnectBtn');
    var disconnectBtn = document.getElementById('xeroDisconnectBtn');
    if (!toggle) return;
    if (!officeId) {
      if (statusEl) statusEl.textContent = 'Not connected — sign in with an office account to use Xero.';
      if (connectBtn) connectBtn.disabled = true;
      if (disconnectBtn) disconnectBtn.disabled = true;
      return;
    }
    try {
      var data = await readOffice(officeId);
      toggle.checked = !!data.xeroExpenseIntegrationEnabled;
      var connected = !!(data.xeroTenantName && String(data.xeroTenantName).trim());
      var codeInp = document.getElementById('xeroBillAccountCodeInput');
      if (codeInp) {
        codeInp.value = data.xeroBillAccountCode != null && data.xeroBillAccountCode !== ''
          ? String(data.xeroBillAccountCode).trim()
          : '';
      }
      if (statusEl) {
        statusEl.textContent = connected
          ? 'Connected: ' + data.xeroTenantName
          : 'Not connected — use Connect Xero button below.';
      }
      if (connectBtn) connectBtn.disabled = false;
      if (disconnectBtn) disconnectBtn.disabled = !connected;
    } catch (e) {
      console.warn('sotoXeroOfficeSettingsPanel.refresh', e);
    }
  }

  async function connect() {
    var officeId = resolveOfficeId();
    if (!officeId) {
      notify('warning', 'Xero', 'No office context.');
      return;
    }
    var hc = getHttpsCallable();
    var fx = getFunctionsInstance();
    if (!hc || !fx) {
      notify('danger', 'Xero', 'Firebase Functions are not ready on this page.');
      return;
    }
    var redirectUri = getXeroRedirectUri();
    try {
      var getUrl = hc(fx, 'xeroGetAuthorizationUrl');
      var res = await getUrl({ redirectUri: redirectUri, officeId: officeId });
      var data = res && res.data ? res.data : null;
      if (!data || !data.url) {
        notify('danger', 'Xero', 'Could not start Xero sign-in.');
        return;
      }
      var w = 520;
      var h = 720;
      var left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
      var top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
      var features = 'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top + ',scrollbars=yes,resizable=yes';
      var popup = window.open(data.url, 'soto_xero_oauth', features);
      if (!popup) {
        notify('warning', 'Xero', 'Pop-up was blocked. Allow pop-ups for this site, then try Connect Xero again.');
      }
    } catch (err) {
      console.error(err);
      notify('danger', 'Xero', (err && err.message) || 'Could not start Xero sign-in.');
    }
  }

  async function disconnect() {
    var officeId = resolveOfficeId();
    if (!officeId) return;
    var ok = await confirmDisconnect();
    if (!ok) return;
    var hc = getHttpsCallable();
    var fx = getFunctionsInstance();
    if (!hc || !fx) return;
    try {
      var fn = hc(fx, 'xeroDisconnect');
      await fn({ officeId: officeId });
      notify('success', 'Xero', 'Xero disconnected for this office.');
      await refresh();
    } catch (err) {
      console.error(err);
      notify('danger', 'Xero', (err && err.message) || 'Could not disconnect Xero.');
    }
  }

  async function saveBillAccountCode() {
    var officeId = resolveOfficeId();
    if (!officeId) {
      notify('warning', 'Xero', 'No office context.');
      return;
    }
    var inp = document.getElementById('xeroBillAccountCodeInput');
    if (!inp) return;
    var v = String(inp.value || '').trim();
    try {
      await updateOffice(officeId, { xeroBillAccountCode: v || '' });
      notify('success', 'Xero', v ? 'Bill account code saved. Try syncing again.' : 'Code cleared — name matching will be used.');
    } catch (e) {
      console.error(e);
      notify('danger', 'Xero', 'Could not save account code. Check Firestore rules / permissions.');
    }
  }

  async function onToggle(checked) {
    var officeId = resolveOfficeId();
    if (!officeId) return;
    try {
      await updateOffice(officeId, { xeroExpenseIntegrationEnabled: !!checked });
    } catch (e) {
      console.error(e);
      if (window.uiDialogs) {
        window.uiDialogs.showAlert({
          title: 'Settings',
          message: 'Could not save Xero setting. You may not have permission to update office settings.',
          tone: 'danger',
        });
      }
      var toggle = document.getElementById('xeroExpenseIntegrationToggle');
      if (toggle) toggle.checked = !checked;
    }
  }

  function mountPanelIfNeeded() {
    var modal = document.getElementById('settingsModal');
    if (!modal) return;
    var bucket = modal.querySelector('.space-y-4');
    if (!bucket || bucket.querySelector('[data-soto-xero-office-settings]')) return;

    var html = [
      '<div class="py-3 border-b border-[#283039]" data-soto-xero-office-settings>',
      '<div class="flex items-start justify-between gap-3">',
      '<div class="flex-1 min-w-0">',
      '<label for="xeroExpenseIntegrationToggle" class="block text-sm font-medium text-white mb-1">Post draft bills to Xero</label>',
      '<p class="text-xs text-gray-400">When enabled, validated batches must be synced to Xero from the Expenses → Validated tab before you can mark them as paid. PDF export only saves files to your computer.</p>',
      '<p id="xeroConnectionStatus" class="text-sm text-gray-300 mt-3 mb-2">Loading…</p>',
      '<div class="flex flex-wrap gap-2">',
      '<button type="button" id="xeroConnectBtn" class="px-3 py-2 bg-[#13B5EA] hover:bg-[#0fa0d1] text-white text-sm rounded-lg font-medium transition-colors">Connect Xero</button>',
      '<button type="button" id="xeroDisconnectBtn" class="px-3 py-2 bg-[#283039] hover:bg-[#3a444e] text-white text-sm rounded-lg border border-gray-600 transition-colors">Disconnect</button>',
      '</div>',
      '<p class="text-xs text-gray-500 mt-3">No existing Xero data is edited or deleted.</p>',
      '</div>',
      '<label class="relative inline-flex items-center cursor-pointer shrink-0 mt-1">',
      '<input type="checkbox" id="xeroExpenseIntegrationToggle" class="sr-only peer">',
      '<div class="w-11 h-6 bg-[#283039] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>',
      '</label>',
      '</div>',
      '<div class="mt-4 pt-3 border-t border-[#283039]">',
      '<label for="xeroBillAccountCodeInput" class="block text-sm font-medium text-white mb-1">Xero bill account code <span class="text-gray-500 font-normal">(optional)</span></label>',
      '<p class="text-xs text-gray-400 mb-2">Leave blank to use an account whose name contains "travel" and "national" (Expense, Overheads, or Direct costs). If your nominal is only an <strong class="text-gray-300">Overheads</strong> code (e.g. 493), enter that code here.</p>',
      '<div class="flex flex-wrap gap-2 items-center">',
      '<input type="text" id="xeroBillAccountCodeInput" maxlength="30" class="w-36 px-2 py-1.5 rounded border border-gray-600 bg-[#1e252d] text-white text-sm placeholder-gray-500" placeholder="e.g. 493" autocomplete="off">',
      '<button type="button" id="xeroBillAccountCodeSaveBtn" class="px-3 py-1.5 text-sm rounded-lg bg-[#283039] text-white border border-gray-600 hover:bg-[#3a444e]">Save code</button>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');

    bucket.insertAdjacentHTML('beforeend', html);

    var toggle = document.getElementById('xeroExpenseIntegrationToggle');
    var connectBtn = document.getElementById('xeroConnectBtn');
    var disconnectBtn = document.getElementById('xeroDisconnectBtn');
    var saveCodeBtn = document.getElementById('xeroBillAccountCodeSaveBtn');
    if (toggle) {
      toggle.addEventListener('change', function () {
        onToggle(toggle.checked);
      });
    }
    if (connectBtn) connectBtn.addEventListener('click', connect);
    if (disconnectBtn) disconnectBtn.addEventListener('click', disconnect);
    if (saveCodeBtn) saveCodeBtn.addEventListener('click', saveBillAccountCode);

    if (!modal._sotoXeroModalObs) {
      modal._sotoXeroModalObs = true;
      var obs = new MutationObserver(function () {
        if (!modal.classList.contains('hidden')) {
          refresh();
        }
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    }

    ensureOAuthListener();
    refresh();
  }

  function init() {
    mountPanelIfNeeded();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.sotoXeroOfficeSettingsPanel = {
    refresh: refresh,
    ensureOAuthListener: ensureOAuthListener,
    mount: mountPanelIfNeeded,
  };
})();
