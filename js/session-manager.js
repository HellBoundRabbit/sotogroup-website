(function(window) {
  const LOGIN_PATH = "/pages/soto-routes-login.html";

  async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForFirebase(maxAttempts = 40, delayMs = 150) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (window.auth && window.firebase?.functions && window.firebase?.httpsCallable) {
        return true;
      }
      await wait(delayMs);
    }
    return false;
  }

  function redirectToLogin() {
    const currentPath = window.location.pathname + window.location.search;
    if (currentPath.includes(LOGIN_PATH)) {
      return;
    }
    const redirectParam = encodeURIComponent(currentPath);
    window.location.href = `${LOGIN_PATH}?redirect=${redirectParam}`;
  }

  /**
   * Wait until Firebase Auth has resolved persistence (modular SDK has no auth.onAuthStateChanged).
   * Many driver pages use modular auth but do not set window.onAuthStateChanged — without a listener
   * we must poll currentUser so PWA / slow storage does not get an immediate null and a login redirect.
   */
  async function resolveCurrentUser() {
    const auth = window.auth;
    if (!auth) {
      return null;
    }

    if (auth.currentUser) {
      return auth.currentUser;
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (explicitUser) => {
        if (settled) {
          return;
        }
        settled = true;
        const u = explicitUser != null ? explicitUser : auth.currentUser;
        resolve(u != null ? u : null);
      };

      let unsub = null;
      const detachListener = () => {
        if (typeof unsub === 'function') {
          try {
            unsub();
          } catch (e) {
            /* ignore */
          }
          unsub = null;
        }
      };

      if (typeof window.onAuthStateChanged === 'function') {
        try {
          unsub = window.onAuthStateChanged(auth, (user) => {
            const resolved = user != null ? user : auth.currentUser;
            if (resolved) {
              detachListener();
              settle(resolved);
            }
          });
        } catch (e) {
          detachListener();
          settle(auth.currentUser);
          return;
        }
      } else if (typeof auth.onAuthStateChanged === 'function') {
        try {
          unsub = auth.onAuthStateChanged((user) => {
            const resolved = user != null ? user : auth.currentUser;
            if (resolved) {
              detachListener();
              settle(resolved);
            }
          });
        } catch (e) {
          detachListener();
          settle(auth.currentUser);
          return;
        }
      }

      const capMs = 10000;
      const deadline = Date.now() + capMs;
      const poll = () => {
        if (settled) {
          return;
        }
        if (auth.currentUser) {
          detachListener();
          settle(auth.currentUser);
          return;
        }
        if (Date.now() >= deadline) {
          detachListener();
          settle(null);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  async function bootstrap(requiredRoles = []) {
    const ready = await waitForFirebase();
    if (!ready) {
      throw new Error("Firebase failed to initialise before session bootstrap.");
    }

    const auth = window.auth;
    if (!auth) {
      throw new Error("Firebase Auth is not available.");
    }

    const user = await resolveCurrentUser();
    if (!user) {
      redirectToLogin();
      return null;
    }

    try {
      const bootstrapFn = window.firebase.httpsCallable(
          window.firebase.functions,
          "bootstrapSession",
      );
      
      // Retry logic for transient Firebase Function errors (e.g. after clearing cache / fresh login)
      let response;
      let lastError;
      const maxRetries = 4;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          response = await bootstrapFn({});
          break; // Success, exit retry loop
        } catch (retryError) {
          lastError = retryError;
          const isRetryable = retryError.code === 'internal' || retryError.code === 'unavailable' || retryError.code === 'deadline-exceeded';
          if (isRetryable && attempt < maxRetries - 1) {
            // Exponential backoff: 300ms, 600ms, 1200ms, 2400ms (one extra retry for "internal" after clear data)
            const delay = 300 * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw retryError;
        }
      }
      
      if (!response) {
        throw lastError || new Error("Failed to get response from bootstrapSession");
      }
      
      const data = response?.data;
      const userData = data?.user;

      if (!userData) {
        throw new Error("Failed to retrieve session user data.");
      }

      if (data?.claimsUpdated) {
        await user.getIdToken(true);
      }

      localStorage.setItem("soto_user_identity", JSON.stringify(userData));

      if (requiredRoles.length > 0 && !requiredRoles.includes(userData.role)) {
        redirectToLogin();
        return null;
      }

      window.currentUserIdentity = userData;
      return userData;
    } catch (error) {
      console.error("[Session] bootstrap failed:", error);
      redirectToLogin();
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem("soto_user_identity");
    delete window.currentUserIdentity;
  }

  window.sotoSession = {
    bootstrap,
    clearSession,
  };
})(window);

