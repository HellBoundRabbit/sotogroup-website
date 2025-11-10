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

  async function resolveCurrentUser() {
    const auth = window.auth;
    if (!auth) {
      return null;
    }

    if (auth.currentUser) {
      return auth.currentUser;
    }

    return new Promise((resolve) => {
      let unsubscribed = false;
      const unsubscribe = auth.onAuthStateChanged ?
        auth.onAuthStateChanged((user) => {
          if (!unsubscribed) {
            unsubscribed = true;
            unsubscribe();
            resolve(user);
          }
        }) :
        window.onAuthStateChanged ?
          window.onAuthStateChanged(auth, (user) => {
            if (!unsubscribed) {
              unsubscribed = true;
              resolve(user);
            }
          }) :
          null;

      if (!unsubscribe) {
        resolve(null);
      }
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
      const response = await bootstrapFn({});
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

