import { clearSession, saveSession } from "./auth";

// One refresh at a time: refresh tokens are single use, and a reused one revokes every session.
let refreshing = null;

function refreshSession() {
  refreshing ??= (async () => {
    const refreshToken = localStorage.getItem("refreshToken");
    if (!refreshToken) return null;
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearSession();
      return null;
    }
    const session = await res.json();
    saveSession(session);
    return session.token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// fetch that adds the Bearer token, and on TOKEN_EXPIRED refreshes once and retries.
export async function authFetch(url, options = {}) {
  const makeRequest = (jwt) => fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
  });

  const res = await makeRequest(localStorage.getItem("token"));
  if (res.status !== 401) return res;

  const errBody = await res.clone().json().catch(() => ({}));
  if (errBody.code !== "TOKEN_EXPIRED") return res;

  const newToken = await refreshSession();
  return newToken ? makeRequest(newToken) : res;
}
