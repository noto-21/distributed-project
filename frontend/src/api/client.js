// Wrapper that automatically calls /api/auth/refresh using your refreshToken and retries the request
export async function authFetch(url, options = {}) {
  const branch = localStorage.getItem("homeBranch");
  let token = localStorage.getItem("accessToken");

  const makeRequest = (jwt) => {
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    // Only attach Authorization header if a valid token string exists
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }

    fetch(url, {
      ...options,
      headers,
    });
  };
  let res = await makeRequest(token);

  // If the 15-min access token expired, rotate it using the refreshToken
  if (res.status === 401) {
    const errBody = await res.clone().json().catch(() => ({}));
    const refreshToken = localStorage.getItem("refreshToken");

    if (errBody.code === "TOKEN_EXPIRED" && refreshToken) {
      const refreshRes = await fetch(`/${branch}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (refreshRes.ok) {
        const session = await refreshRes.json();
        localStorage.setItem("accessToken", session.token);
        localStorage.setItem("refreshToken", session.refreshToken);
        // Retry the original request with the new JWT
        res = await makeRequest(session.token);
      } else {
        // Refresh token invalid or reused, clear session
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
      }
    }
  }

  return res;
}
