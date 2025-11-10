(function () {
    if (window.uiDialogs) {
        return;
    }

    const TONES = {
        info: {
            accent: '#2563eb',
            accentSoft: 'rgba(37, 99, 235, 0.16)',
            accentHighlight: '#60a5fa',
            icon: 'info',
            iconColor: '#60a5fa',
            iconBackground: 'rgba(15, 23, 42, 0.94)',
            glow: 'rgba(37, 99, 235, 0.35)',
        },
        success: {
            accent: '#22c55e',
            accentSoft: 'rgba(34, 197, 94, 0.16)',
            accentHighlight: '#86efac',
            icon: 'check',
            iconColor: '#4ade80',
            iconBackground: 'rgba(15, 23, 42, 0.94)',
            glow: 'rgba(34, 197, 94, 0.32)',
        },
        warning: {
            accent: '#f97316',
            accentSoft: 'rgba(249, 115, 22, 0.18)',
            accentHighlight: '#fb923c',
            icon: 'warning',
            iconColor: '#fb923c',
            iconBackground: 'rgba(15, 23, 42, 0.94)',
            glow: 'rgba(249, 115, 22, 0.32)',
        },
        danger: {
            accent: '#ef4444',
            accentSoft: 'rgba(239, 68, 68, 0.18)',
            accentHighlight: '#f87171',
            icon: 'error',
            iconColor: '#f87171',
            iconBackground: 'rgba(15, 23, 42, 0.94)',
            glow: 'rgba(239, 68, 68, 0.36)',
        },
    };

    const ICON_PATHS = {
        info: 'M12 2C6.485 2 2 6.485 2 12s4.485 10 10 10 10-4.485 10-10S17.515 2 12 2zm0 3a1.25 1.25 0 110 2.5A1.25 1.25 0 0112 5zm1.5 13h-3a1 1 0 010-2h1v-4h-1a1 1 0 010-2h2a1 1 0 011 1v5h1a1 1 0 010 2z',
        check: 'M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm4.707 8.707l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L11 13.586l4.293-4.293a1 1 0 011.414 1.414z',
        warning: 'M11.05 3.464c.513-.889 1.887-.889 2.4 0l8.254 14.31c.513.888-.128 2-1.2 2H3.996c-1.072 0-1.713-1.112-1.2-2zM12 9a1 1 0 00-1 1v4a1 1 0 002 0v-4a1 1 0 00-1-1zm0 8a1.25 1.25 0 111.25-1.25A1.25 1.25 0 0112 17z',
        error: 'M12 2a10 10 0 1010 10A10.014 10.014 0 0012 2zm2.707 12.707a1 1 0 01-1.414 0L12 13.414l-1.293 1.293a1 1 0 11-1.414-1.414L10.586 12 9.293 10.707a1 1 0 111.414-1.414L12 10.586l1.293-1.293a1 1 0 011.414 1.414L13.414 12l1.293 1.293a1 1 0 010 1.414z',
    };

    const state = {
        initialized: false,
        overlay: null,
        modal: null,
        title: null,
        message: null,
        primaryButton: null,
        secondaryButton: null,
        closeButton: null,
        accent: null,
        iconPath: null,
        iconCircle: null,
        toastContainer: null,
        resolver: null,
        activeTone: 'info',
        previousFocus: null,
        keyHandler: null,
    };

    function ensureStyles() {
        if (document.getElementById('ui-dialogs-styles')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'ui-dialogs-styles';
        style.textContent = `
            .ui-toast-container {
                position: fixed;
                top: 1.5rem;
                right: 1.5rem;
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                z-index: 9999;
                pointer-events: none;
            }

            .ui-toast {
                pointer-events: auto;
                min-width: 280px;
                max-width: 360px;
                background: #111827;
                border: 1px solid #1f2937;
                border-radius: 0.75rem;
                padding: 1rem 1.25rem;
                box-shadow: 0 20px 45px rgba(2, 6, 23, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.02);
                color: #f9fafb;
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                transform: translateY(-10px);
                opacity: 0;
                transition: opacity 0.2s ease, transform 0.2s ease;
            }

            .ui-toast[data-visible="true"] {
                opacity: 1;
                transform: translateY(0);
            }

            .ui-toast-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.75rem;
            }

            .ui-toast-title {
                font-weight: 600;
                font-size: 0.95rem;
            }

            .ui-toast-message {
                font-size: 0.85rem;
                color: #d1d5db;
                line-height: 1.45;
            }

            .ui-toast-close {
                background: transparent;
                border: none;
                color: rgba(209, 213, 219, 0.6);
                cursor: pointer;
                padding: 0.25rem;
                border-radius: 0.5rem;
                transition: background-color 0.2s ease, color 0.2s ease;
            }

            .ui-toast-close:hover {
                background-color: rgba(31, 41, 55, 0.6);
                color: #f9fafb;
            }

            .ui-toast-accent {
                width: 100%;
                height: 3px;
                border-radius: 999px;
            }

            .ui-dialogs-overlay {
                position: fixed;
                inset: 0;
                background: rgba(9, 11, 18, 0.65);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 1.5rem;
                z-index: 9998;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.25s ease;
            }

            .ui-dialogs-overlay[data-visible="true"] {
                opacity: 1;
                pointer-events: auto;
            }

            .ui-dialogs-modal {
                background: #111827;
                border: 1px solid #1f2937;
                border-radius: 1rem;
                width: min(420px, 100%);
                box-shadow: 0 28px 60px rgba(2, 6, 23, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.04);
                transform: translateY(20px);
                opacity: 0;
                transition: transform 0.25s ease, opacity 0.25s ease;
            }

            .ui-dialogs-overlay[data-visible="true"] .ui-dialogs-modal {
                transform: translateY(0);
                opacity: 1;
            }

            .ui-dialogs-accent {
                display: none;
                height: 0;
            }

            .ui-dialogs-content {
                padding: 1.75rem 1.75rem 1.5rem;
                color: #f9fafb;
            }

            .ui-dialogs-header {
                display: flex;
                align-items: flex-start;
                gap: 1rem;
            }

            .ui-dialogs-icon {
                width: 2.75rem;
                height: 2.75rem;
                border-radius: 0.85rem;
                background: rgba(17, 24, 39, 0.92);
                border: 1px solid rgba(148, 163, 184, 0.18);
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }

            .ui-dialogs-icon svg {
                width: 1.4rem;
                height: 1.4rem;
                display: block;
            }

            .ui-dialogs-title {
                font-size: 1.1rem;
                font-weight: 600;
                margin: 0 0 0.35rem;
            }

            .ui-dialogs-message {
                font-size: 0.92rem;
                color: #d1d5db;
                line-height: 1.5;
                margin: 0;
                white-space: pre-line;
            }

            .ui-dialogs-actions {
                display: flex;
                gap: 0.75rem;
                justify-content: flex-end;
                padding: 0 1.75rem 1.75rem;
            }

            .ui-dialogs-button {
                border: none;
                border-radius: 0.75rem;
                font-weight: 600;
                font-size: 0.95rem;
                padding: 0.75rem 1.5rem;
                cursor: pointer;
                transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.2s ease;
                outline: none;
            }

            .ui-dialogs-button:focus-visible {
                box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.35);
            }

            .ui-dialogs-button[data-variant="secondary"] {
                background: rgba(31, 41, 55, 0.8);
                color: rgba(229, 231, 235, 0.85);
            }

            .ui-dialogs-button[data-variant="secondary"]:hover {
                background: rgba(55, 65, 81, 0.8);
            }

            .ui-dialogs-button[data-variant="primary"] {
                background: rgba(10, 14, 23, 0.95);
                color: #f9fafb;
                border: 1px solid rgba(148, 163, 184, 0.32);
                box-shadow: none;
            }

            .ui-dialogs-button[data-variant="primary"]:hover {
                background: rgba(17, 23, 36, 0.97);
            }

            .ui-dialogs-close {
                position: absolute;
                top: 1.25rem;
                right: 1.25rem;
                background: transparent;
                border: none;
                width: 1.75rem;
                height: 1.75rem;
                color: rgba(229, 231, 235, 0.65);
                cursor: pointer;
                transition: color 0.2s ease;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .ui-dialogs-close:hover {
                color: #f9fafb;
            }

            .ui-dialogs-close svg {
                width: 1.1rem;
                height: 1.1rem;
            }

            @media (max-width: 640px) {
                .ui-toast-container {
                    right: 1rem;
                    left: 1rem;
                    width: auto;
                }

                .ui-toast {
                    width: 100%;
                    min-width: auto;
                }

                .ui-dialogs-overlay {
                    padding: 1rem;
                }

                .ui-dialogs-modal {
                    width: 100%;
                }
            }
        `;

        document.head.appendChild(style);
    }

    function buildIcon(type) {
        const namespace = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(namespace, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', ICON_PATHS[type] || ICON_PATHS.info);
        svg.appendChild(path);
        return svg;
    }

    function init() {
        if (state.initialized) {
            return;
        }

        ensureStyles();

        const overlay = document.createElement('div');
        overlay.id = 'ui-dialogs-overlay';
        overlay.className = 'ui-dialogs-overlay';
        overlay.setAttribute('role', 'presentation');

        overlay.innerHTML = `
            <div class="ui-dialogs-modal" role="alertdialog" aria-modal="true" aria-labelledby="ui-dialogs-title" aria-describedby="ui-dialogs-message">
                <div class="ui-dialogs-accent"></div>
                <button class="ui-dialogs-close" type="button" aria-label="Close dialog"></button>
                <div class="ui-dialogs-content">
                    <div class="ui-dialogs-header">
                        <div class="ui-dialogs-icon"></div>
                        <div class="ui-dialogs-copy">
                            <h3 class="ui-dialogs-title" id="ui-dialogs-title"></h3>
                            <p class="ui-dialogs-message" id="ui-dialogs-message"></p>
                        </div>
                    </div>
                </div>
                <div class="ui-dialogs-actions">
                    <button class="ui-dialogs-button" data-variant="secondary" type="button"></button>
                    <button class="ui-dialogs-button" data-variant="primary" type="button"></button>
                </div>
            </div>
        `;

        const toastContainer = document.createElement('div');
        toastContainer.className = 'ui-toast-container';
        toastContainer.id = 'ui-toast-container';

        document.body.appendChild(overlay);
        document.body.appendChild(toastContainer);

        state.initialized = true;
        state.overlay = overlay;
        state.modal = overlay.querySelector('.ui-dialogs-modal');
        state.accent = overlay.querySelector('.ui-dialogs-accent');
        state.title = overlay.querySelector('.ui-dialogs-title');
        state.message = overlay.querySelector('.ui-dialogs-message');
        state.primaryButton = overlay.querySelector('.ui-dialogs-button[data-variant="primary"]');
        state.secondaryButton = overlay.querySelector('.ui-dialogs-button[data-variant="secondary"]');
        state.closeButton = overlay.querySelector('.ui-dialogs-close');
        state.iconWrapper = overlay.querySelector('.ui-dialogs-icon');
        state.toastContainer = toastContainer;

        state.iconWrapper.appendChild(buildIcon('info'));

        state.closeButton.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        `;
        state.closeButton.addEventListener('click', () => resolveModal(false));
        state.secondaryButton.addEventListener('click', () => resolveModal(false));
        state.primaryButton.addEventListener('click', () => resolveModal(true));

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                resolveModal(false);
            }
        });
    }

    function ensureInit() {
        if (state.initialized) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const attemptInit = () => {
                init();
                resolve();
            };

            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                attemptInit();
            } else {
                document.addEventListener('DOMContentLoaded', attemptInit, { once: true });
            }
        });
    }

    function setTone(toneKey) {
        const tone = TONES[toneKey] || TONES.info;
        state.activeTone = toneKey || 'info';
        const highlight = tone.accentHighlight || shadeColor(tone.accent, 18);
        state.accent.style.background = `linear-gradient(90deg, ${tone.accentSoft}, ${highlight})`;
        state.iconWrapper.style.background = tone.iconBackground || 'rgba(17, 24, 39, 0.94)';
        state.iconWrapper.style.borderColor = tone.accentSoft || 'rgba(148, 163, 184, 0.25)';
        state.iconWrapper.style.color = tone.iconColor || '#f9fafb';

        state.iconWrapper.replaceChildren(buildIcon(tone.icon));

        if (state.primaryButton) {
            state.primaryButton.style.background = 'rgba(10, 14, 23, 0.95)';
            state.primaryButton.style.color = tone.accentHighlight || '#f9fafb';
            state.primaryButton.style.border = `1px solid ${tone.accent}`;
            state.primaryButton.style.boxShadow = `0 6px 24px ${tone.glow || 'rgba(99, 102, 241, 0.28)'}`;
            state.primaryButton.onmouseenter = () => {
                state.primaryButton.style.background = 'rgba(17, 23, 36, 0.97)';
            };
            state.primaryButton.onmouseleave = () => {
                state.primaryButton.style.background = 'rgba(10, 14, 23, 0.95)';
            };
        }
    }

    function shadeColor(color, percent) {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const r = (num >> 16) + amt;
        const g = ((num >> 8) & 0x00ff) + amt;
        const b = (num & 0x0000ff) + amt;
        return (
            '#' +
            (
                0x1000000 +
                (r < 255 ? (r < 1 ? 0 : r) : 255) * 0x10000 +
                (g < 255 ? (g < 1 ? 0 : g) : 255) * 0x100 +
                (b < 255 ? (b < 1 ? 0 : b) : 255)
            )
                .toString(16)
                .slice(1)
        );
    }

    function resolveModal(result) {
        if (!state.overlay || state.overlay.getAttribute('data-visible') !== 'true') {
            return;
        }

        state.overlay.setAttribute('data-visible', 'false');

        if (state.keyHandler) {
            document.removeEventListener('keydown', state.keyHandler);
            state.keyHandler = null;
        }

        if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
            state.previousFocus.focus();
        }

        const resolver = state.resolver;
        state.resolver = null;

        if (resolver) {
            resolver(result);
        }
    }

    function openModal(options, mode) {
        return ensureInit().then(() => {
            const {
                title = '',
                message = '',
                confirmText = 'OK',
                cancelText = 'Cancel',
                tone = 'info',
                showCancel = mode === 'confirm',
            } = options || {};

            state.title.textContent = title;
            state.message.textContent = message;
            state.primaryButton.textContent = confirmText;
            state.secondaryButton.textContent = cancelText;
            state.secondaryButton.style.display = showCancel ? 'inline-flex' : 'none';

            setTone(tone);

            state.previousFocus = document.activeElement;

            state.overlay.setAttribute('data-visible', 'true');
            state.modal.setAttribute('aria-hidden', 'false');

            state.resolver = null;

            return new Promise((resolve) => {
                state.resolver = resolve;
                state.primaryButton.focus();

                state.keyHandler = (event) => {
                    if (event.key === 'Escape') {
                        resolveModal(false);
                    } else if (event.key === 'Enter') {
                        if (document.activeElement === state.secondaryButton && showCancel) {
                            resolveModal(false);
                        } else {
                            resolveModal(true);
                        }
                    }
                };

                document.addEventListener('keydown', state.keyHandler);
            });
        });
    }

    function showAlert(options) {
        const normalized =
            typeof options === 'string'
                ? { title: 'Notice', message: options }
                : options || {};
        return openModal(normalized, 'alert').then(() => undefined);
    }

    function showConfirm(options) {
        const normalized =
            typeof options === 'string'
                ? { title: 'Please Confirm', message: options }
                : options || {};
        return openModal({ ...normalized, showCancel: true }, 'confirm');
    }

    function showToast(options) {
        const normalized =
            typeof options === 'string'
                ? { title: 'Notice', message: options }
                : options || {};

        return ensureInit().then(() => {
            const {
                title = '',
                message = '',
                tone = 'info',
                duration = 4500,
            } = normalized;

            const toneConfig = TONES[tone] || TONES.info;
            const toastHighlight = toneConfig.accentHighlight || shadeColor(toneConfig.accent, 18);

            const toast = document.createElement('div');
            toast.className = 'ui-toast';
            toast.innerHTML = `
                <div class="ui-toast-accent" style="background: linear-gradient(90deg, ${toneConfig.accentSoft}, ${toastHighlight});"></div>
                <div class="ui-toast-header">
                    <span class="ui-toast-title">${title || 'Notification'}</span>
                    <button class="ui-toast-close" type="button" aria-label="Dismiss notification">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" stroke-linejoin="round"></path>
                        </svg>
                    </button>
                </div>
                <div class="ui-toast-message">${message}</div>
            `;

            state.toastContainer.appendChild(toast);

            requestAnimationFrame(() => {
                toast.setAttribute('data-visible', 'true');
            });

            const removeToast = () => {
                toast.setAttribute('data-visible', 'false');
                setTimeout(() => {
                    toast.remove();
                }, 200);
            };

            const timeout = setTimeout(removeToast, duration);

            toast
                .querySelector('.ui-toast-close')
                .addEventListener('click', () => {
                    clearTimeout(timeout);
                    removeToast();
                });

            return {
                dismiss: () => {
                    clearTimeout(timeout);
                    removeToast();
                },
            };
        });
    }

    window.uiDialogs = {
        showAlert,
        showConfirm,
        showToast,
        hideActiveModal: () => resolveModal(false),
    };

    window.showAlertDialog = showAlert;
    window.showConfirmation = showConfirm;
    window.showToastMessage = showToast;
})();

