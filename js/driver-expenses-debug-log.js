/**
 * Persisted daily diagnostic log for driver-expenses page.
 * Survives tab close / return same calendar day (local timezone).
 * Bug button uploads chunks to Firestore collection driverExpenseDebugReports.
 */
(function () {
    'use strict';

    var PAGE_ID = 'driver-expenses';
    var DB_NAME = 'DriverExpensesDebugLogDB';
    var DB_VERSION = 1;
    var STORE = 'dayLogs';
    var MAX_ENTRIES = 2200;
    var MAX_MSG_LEN = 600;
    var MAX_META_JSON = 3500;
    var PERSIST_DEBOUNCE_MS = 350;
    /** Max characters per Firestore doc for pasteableText (stay under 1 MiB document limit). */
    var PASTE_TEXT_CHUNK_CHARS = 180000;

    var dbPromise = null;
    var memoryEntries = [];
    var persistTimer = null;
    var currentDayKey = null;
    var originals = null;
    var installed = false;

    function getLocalDayKey() {
        var d = new Date();
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function truncate(str, n) {
        if (str == null) return '';
        var s = String(str);
        return s.length <= n ? s : s.slice(0, n) + '…';
    }

    function safeStringifyMeta(obj) {
        if (obj == null) return null;
        try {
            var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
            function walk(v, depth) {
                if (depth > 4) return '[Deep]';
                if (v == null) return v;
                if (typeof v === 'string') return truncate(v, 800);
                if (typeof v === 'number' || typeof v === 'boolean') return v;
                if (v instanceof Error) {
                    return { name: v.name, message: truncate(v.message, 500), stack: truncate(v.stack || '', 1200) };
                }
                if (typeof v === 'function') return '[Function]';
                if (typeof v === 'object') {
                    if (seen && seen.has(v)) return '[Circular]';
                    if (seen) seen.add(v);
                    if (Array.isArray(v)) {
                        return v.slice(0, 30).map(function (x) { return walk(x, depth + 1); });
                    }
                    var o = {};
                    var keys = Object.keys(v).slice(0, 40);
                    for (var i = 0; i < keys.length; i++) {
                        var k = keys[i];
                        try {
                            o[k] = walk(v[k], depth + 1);
                        } catch (e) {
                            o[k] = '[Err]';
                        }
                    }
                    return o;
                }
                return String(v);
            }
            var out = JSON.stringify(walk(obj, 0));
            if (out.length > MAX_META_JSON) return out.slice(0, MAX_META_JSON) + '…';
            return JSON.parse(out);
        } catch (e) {
            return { _stringifyError: String(e && e.message) };
        }
    }

    function formatArg(a) {
        if (a == null) return String(a);
        if (typeof a === 'string') return a;
        if (typeof a === 'number' || typeof a === 'boolean') return String(a);
        if (a instanceof Error) return a.name + ': ' + a.message;
        try {
            return truncate(JSON.stringify(a), 400);
        } catch (e) {
            return '[Object]';
        }
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = function () { reject(req.error); };
            req.onsuccess = function () { resolve(req.result); };
            req.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'dayKey' });
                }
            };
        });
        return dbPromise;
    }

    function idbDeleteOldDays(todayKey) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var store = tx.objectStore(STORE);
                var req = store.getAllKeys();
                req.onsuccess = function () {
                    var keys = req.result || [];
                    keys.forEach(function (k) {
                        if (k !== todayKey) {
                            store.delete(k);
                        }
                    });
                };
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function idbLoadDay(dayKey) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readonly');
                var store = tx.objectStore(STORE);
                var g = store.get(dayKey);
                g.onsuccess = function () {
                    resolve(g.result || null);
                };
                g.onerror = function () { reject(g.error); };
            });
        });
    }

    function idbSaveDay(dayKey, entries) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var store = tx.objectStore(STORE);
                store.put({
                    dayKey: dayKey,
                    entries: entries,
                    updatedAt: Date.now()
                });
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function trimEntries(arr) {
        while (arr.length > MAX_ENTRIES) {
            arr.shift();
        }
    }

    function appendEntry(entry) {
        var dk = getLocalDayKey();
        if (currentDayKey && dk !== currentDayKey) {
            rolloverDay(dk);
        }
        currentDayKey = dk;
        entry.t = entry.t || Date.now();
        memoryEntries.push(entry);
        trimEntries(memoryEntries);
        schedulePersist();
    }

    function rolloverDay(newDayKey) {
        memoryEntries = [];
        currentDayKey = newDayKey;
        idbDeleteOldDays(newDayKey).catch(function () {});
        appendEntry({ level: 'info', type: 'lifecycle', msg: 'Day rollover — log buffer reset for ' + newDayKey });
    }

    function schedulePersist() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
    }

    function flushPersist() {
        persistTimer = null;
        var dk = getLocalDayKey();
        idbSaveDay(dk, memoryEntries.slice()).catch(function (e) {
            if (originals && originals.error) originals.error.call(console, '[DriverExpensesDebugLog] persist failed', e);
        });
    }

    function installConsoleTap() {
        if (installed || typeof console === 'undefined') return;
        originals = {
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            debug: console.debug ? console.debug.bind(console) : null
        };
        installed = true;

        function wrap(level, orig) {
            return function () {
                try {
                    var parts = [];
                    for (var i = 0; i < arguments.length; i++) {
                        parts.push(formatArg(arguments[i]));
                    }
                    var msg = truncate(parts.join(' '), MAX_MSG_LEN);
                    appendEntry({ level: level, type: 'console', msg: msg });
                } catch (e) { /* ignore */ }
                return orig.apply(console, arguments);
            };
        }

        console.log = wrap('log', originals.log);
        console.warn = wrap('warn', originals.warn);
        console.error = wrap('error', originals.error);
        if (originals.debug) {
            console.debug = wrap('debug', originals.debug);
        }
    }

    function onWindowError(message, source, lineno, colno, err) {
        appendEntry({
            level: 'error',
            type: 'window.onerror',
            msg: truncate(String(message), MAX_MSG_LEN),
            meta: safeStringifyMeta({
                source: source,
                lineno: lineno,
                colno: colno,
                error: err ? { message: err.message, stack: err.stack } : null
            })
        });
    }

    function onRejection(ev) {
        var r = ev && ev.reason;
        appendEntry({
            level: 'error',
            type: 'unhandledrejection',
            msg: truncate(r instanceof Error ? r.message : String(r), MAX_MSG_LEN),
            meta: safeStringifyMeta(r instanceof Error ? { name: r.name, message: r.message, stack: r.stack } : { reason: r })
        });
    }

    function onOnline() {
        appendEntry({ level: 'info', type: 'connectivity', msg: 'online', meta: { onLine: true } });
    }

    function onOffline() {
        appendEntry({ level: 'warn', type: 'connectivity', msg: 'offline', meta: { onLine: false } });
    }

    function onVisibility() {
        appendEntry({
            level: 'info',
            type: 'visibility',
            msg: document.hidden ? 'hidden' : 'visible',
            meta: { hidden: document.hidden, visibilityState: document.visibilityState }
        });
    }

    function onPageHide() {
        flushPersist();
        appendEntry({ level: 'info', type: 'lifecycle', msg: 'pagehide' });
        flushPersist();
    }

    function onMidnightCheck() {
        var dk = getLocalDayKey();
        if (currentDayKey && dk !== currentDayKey) {
            rolloverDay(dk);
        }
    }

    /** Compact text for Firestore + quick scan in console (not full entries). */
    function buildAiSummary(entries) {
        var errCount = 0;
        var warnCount = 0;
        var i;
        for (i = 0; i < entries.length; i++) {
            var lev = entries[i].level;
            if (lev === 'error') errCount++;
            if (lev === 'warn') warnCount++;
        }
        var hotRe = /sync|upload|fail|error|queue|rollback|timeout|firestore|expense|ExpenseUpload|Service Worker|SW |offline|exception|rollback|pending|processed/i;
        var hotLines = [];
        var seen = {};
        for (i = 0; i < entries.length && hotLines.length < 45; i++) {
            var e = entries[i];
            var msg = String(e.msg || '');
            var hit = hotRe.test(msg) || hotRe.test(String(e.type || '')) || e.level === 'error' || e.level === 'warn';
            if (!hit) continue;
            var key = msg.slice(0, 120);
            if (seen[key]) continue;
            seen[key] = true;
            hotLines.push((e.level || '') + '\t[' + (e.type || '') + ']\t' + truncate(msg, 220));
        }
        var tail = [];
        for (i = Math.max(0, entries.length - 15); i < entries.length; i++) {
            var x = entries[i];
            tail.push((x.level || '') + '\t' + truncate(String(x.msg || ''), 200));
        }
        var parts = [
            'entryCount=' + entries.length + ' errors=' + errCount + ' warns=' + warnCount,
            '--- likely-relevant lines (deduped) ---'
        ].concat(hotLines);
        parts.push('--- last 15 lines ---');
        parts = parts.concat(tail);
        return truncate(parts.join('\n'), 7800);
    }

    function isoTime(t) {
        try {
            return new Date(t || Date.now()).toISOString();
        } catch (e) {
            return String(t);
        }
    }

    /**
     * Full paste-friendly block for Firebase or clipboard.
     * @param {object} [options] - `{ maxChars }` default 120000; use `{ noTruncate: true }` for full-day upload to Firestore.
     */
    function buildPasteReadyText(entries, options) {
        options = options || {};
        var maxChars = options.noTruncate ? Infinity : (options.maxChars != null ? options.maxChars : 120000);
        var lines = [];
        lines.push('=== SOTO driver-expenses diagnostic (paste to support / AI) ===');
        lines.push('localDate: ' + getLocalDayKey());
        lines.push('entryCount: ' + entries.length);
        if (typeof navigator !== 'undefined') {
            lines.push('online: ' + navigator.onLine);
            lines.push('userAgent: ' + navigator.userAgent);
        }
        if (window.auth && window.auth.currentUser && window.auth.currentUser.uid) {
            lines.push('driverId: ' + window.auth.currentUser.uid);
        }
        lines.push('');
        lines.push('--- AUTO SUMMARY ---');
        lines.push(buildAiSummary(entries));
        lines.push('');
        lines.push('--- FULL LOG (newest at bottom; meta only when present) ---');
        var i;
        for (i = 0; i < entries.length; i++) {
            var e = entries[i];
            var row = isoTime(e.t) + ' | ' + (e.level || '') + ' | ' + (e.type || '') + ' | ' + String(e.msg || '').replace(/\r?\n/g, ' ');
            if (e.meta != null) {
                try {
                    var mj = JSON.stringify(e.meta);
                    if (mj.length > 500) mj = mj.slice(0, 500) + '…';
                    row += ' | meta:' + mj;
                } catch (ignore) { /* empty */ }
            }
            lines.push(row);
        }
        var out = lines.join('\n');
        if (maxChars !== Infinity && out.length > maxChars) {
            out = truncate(out, maxChars) + '\n\n[TRUNCATED to ' + maxChars + ' chars]';
        }
        return out;
    }

    /** Split formatted report into Firestore-safe string chunks. */
    function chunkPasteableTextForFirestore(fullText) {
        var t = fullText == null ? '' : String(fullText);
        if (t.length === 0) {
            return ['(empty report)'];
        }
        var chunks = [];
        for (var i = 0; i < t.length; i += PASTE_TEXT_CHUNK_CHARS) {
            chunks.push(t.slice(i, i + PASTE_TEXT_CHUNK_CHARS));
        }
        return chunks;
    }

    function copyLogForSupport() {
        flushPersist();
        var text = buildPasteReadyText(memoryEntries.slice(), { maxChars: 120000 });
        function okToast() {
            if (window.uiDialogs && typeof window.uiDialogs.showToast === 'function') {
                window.uiDialogs.showToast({
                    title: 'Copied',
                    message: 'Paste into Cursor, email, or Notes. Summary is at the top.',
                    tone: 'success',
                    duration: 5000
                });
            } else if (window.uiDialogs && window.uiDialogs.showAlert) {
                window.uiDialogs.showAlert({ title: 'Copied', message: 'Log copied to clipboard.', tone: 'success' });
            } else {
                alert('Copied to clipboard.');
            }
        }
        function fail() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                okToast();
            } catch (e) {
                if (window.uiDialogs && window.uiDialogs.showAlert) {
                    window.uiDialogs.showAlert({
                        title: 'Copy failed',
                        message: 'Select and copy manually from a desktop browser.',
                        tone: 'warning'
                    });
                } else {
                    alert('Copy failed.');
                }
            }
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(okToast).catch(fail);
        }
        fail();
        return Promise.resolve();
    }

    function confirmBugReport() {
        var ui = window.uiDialogs;
        if (ui && typeof ui.showConfirmation === 'function') {
            return ui.showConfirmation({
                title: 'Report a problem?',
                message: "Send today's diagnostic log from this page to support? It helps us fix upload and sync issues. Logs are kept only for today on your device until you send this.",
                confirmLabel: 'Send',
                cancelLabel: 'Cancel'
            });
        }
        return Promise.resolve(confirm('Send today\'s diagnostic log to support?'));
    }

    function submitBugReport() {
        if (submitBugReport._busy) return;
        confirmBugReport().then(function (ok) {
            if (!ok) return;
            submitBugReport._busy = true;
            return doSubmit().finally(function () {
                submitBugReport._busy = false;
            });
        });
    }

    function doSubmit() {
        var ensure = typeof window.ensureFirebaseAuthReady === 'function'
            ? window.ensureFirebaseAuthReady()
            : Promise.resolve();
        return ensure.then(function () {
            if (!window.auth || !window.auth.currentUser) {
                if (window.uiDialogs && window.uiDialogs.showAlert) {
                    window.uiDialogs.showAlert({ title: 'Sign in required', message: 'Please sign in, then try again.', tone: 'warning' });
                } else {
                    alert('Please sign in, then try again.');
                }
                return;
            }
            if (!window.db || !window.addDoc || !window.collection) {
                alert('App not ready. Please wait and try again.');
                return;
            }
            flushPersist();
            var uid = window.auth.currentUser.uid;
            var officeId = (window.currentUser && window.currentUser.officeId) != null ? window.currentUser.officeId : null;
            var localDate = getLocalDayKey();
            var allEntries = memoryEntries.slice();
            if (allEntries.length === 0) {
                allEntries.push({
                    t: Date.now(),
                    level: 'info',
                    type: 'lifecycle',
                    msg: 'Bug report with no buffered lines yet — describe what happened when reporting elsewhere if needed.'
                });
            }
            var reportGroupId =
                (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : 'rg_' + Date.now() + '_' + Math.random().toString(36).slice(2);
            var summaryText = buildAiSummary(allEntries);
            var fullPasteText = buildPasteReadyText(allEntries, { noTruncate: true });
            var textChunks = chunkPasteableTextForFirestore(fullPasteText);
            var partCount = textChunks.length;
            var col = window.collection(window.db, 'driverExpenseDebugReports');
            var seq = Promise.resolve();
            var clientTs = Date.now();

            function showOk() {
                var m = 'Sent ' + partCount + ' text part' + (partCount === 1 ? '' : 's') + ' to Firebase. Open each document with the same reportGroupId, copy field pasteableText in order (0…' + (partCount - 1) + '), paste together here.';
                if (window.uiDialogs && window.uiDialogs.showAlert) {
                    window.uiDialogs.showAlert({ title: 'Report sent', message: m, tone: 'success' });
                } else {
                    alert(m);
                }
            }

            function showErr(err) {
                var msg = (err && err.message) ? err.message : String(err);
                if (window.uiDialogs && window.uiDialogs.showAlert) {
                    window.uiDialogs.showAlert({ title: 'Could not send', message: msg, tone: 'danger' });
                } else {
                    alert('Could not send: ' + msg);
                }
            }

            for (var p = 0; p < partCount; p++) {
                (function (partIndex) {
                    seq = seq.then(function () {
                        var payload = {
                            driverId: uid,
                            officeId: officeId,
                            pageId: PAGE_ID,
                            localDate: localDate,
                            reportGroupId: reportGroupId,
                            partIndex: partIndex,
                            partCount: partCount,
                            summary: summaryText,
                            pasteableText: textChunks[partIndex],
                            userAgent: truncate(navigator.userAgent, 500),
                            online: !!navigator.onLine,
                            clientTimestampMs: clientTs
                        };
                        return window.addDoc(col, payload);
                    });
                })(p);
            }
            return seq.then(showOk).catch(showErr);
        });
    }

    /** Console tap runs as soon as this script loads (before DOMContentLoaded) so inline script logs are captured. */
    installConsoleTap();

    function init() {
        currentDayKey = getLocalDayKey();

        return idbDeleteOldDays(currentDayKey)
            .then(function () {
                return idbLoadDay(currentDayKey);
            })
            .then(function (rec) {
                var fromDisk = (rec && Array.isArray(rec.entries)) ? rec.entries.slice() : [];
                var fromMem = memoryEntries.slice();
                memoryEntries = fromDisk.concat(fromMem);
                memoryEntries.sort(function (a, b) {
                    return (a.t || 0) - (b.t || 0);
                });
                trimEntries(memoryEntries);
                appendEntry({
                    level: 'info',
                    type: 'lifecycle',
                    msg: 'Driver expenses debug log session ready',
                    meta: { dayKey: currentDayKey, path: typeof location !== 'undefined' ? location.pathname : '', restoredFromDisk: fromDisk.length }
                });
            })
            .catch(function (e) {
                appendEntry({ level: 'warn', type: 'lifecycle', msg: 'IndexedDB init issue', meta: safeStringifyMeta(e) });
            })
            .then(function () {
                window.addEventListener('error', onWindowError);
                window.addEventListener('unhandledrejection', onRejection);
                window.addEventListener('online', onOnline);
                window.addEventListener('offline', onOffline);
                document.addEventListener('visibilitychange', onVisibility);
                window.addEventListener('pagehide', onPageHide);
                setInterval(onMidnightCheck, 60000);

                var btn = document.getElementById('driverExpensesBugReportBtn');
                if (btn) {
                    btn.addEventListener('click', function () {
                        submitBugReport();
                    });
                }
            });
    }

    window.DriverExpensesDebugLog = {
        init: init,
        log: function (level, msg, meta) {
            appendEntry({ level: level || 'info', type: 'app', msg: truncate(String(msg), MAX_MSG_LEN), meta: meta != null ? safeStringifyMeta(meta) : null });
        },
        flush: flushPersist,
        getLocalDayKey: getLocalDayKey,
        copyLogForSupport: copyLogForSupport,
        buildPasteReadyText: function (opts) {
            return buildPasteReadyText(memoryEntries.slice(), opts);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init();
        }, { once: true });
    } else {
        init();
    }
})();

