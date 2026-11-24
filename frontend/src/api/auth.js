// Auth calls for the login, signup and Google callback pages. See docs/api.md "Auth".
export const BRANCH_OPTIONS = ["ajax", "oshawa", "whitby"];

export function saveSession(session) {
  localStorage.setItem("token", session.token);
  localStorage.setItem("refreshToken", session.refreshToken);
  localStorage.setItem("homeBranch", session.homeBranch ?? session.user?.homeBranch);
}

export function clearSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("homeBranch");
}

// Revoke the refresh token on the server too; local sign-out happens even if that call fails.
export async function logout() {
  const refreshToken = localStorage.getItem("refreshToken");
  clearSession();
  if (!refreshToken) return;
  await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => {});
}

async function postAuth(path, body, fallbackError) {
  const res = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || fallbackError);
  saveSession(data);
  return data;
}

export function login(email, password) {
  return postAuth("login", { email, password }, "Log in failed.");
}

export function register({ name, email, password, homeBranch }) {
  if (!BRANCH_OPTIONS.includes(homeBranch)) throw new Error("Choose your home branch.");
  return postAuth("register", { name, email, password, homeBranch }, "Sign up failed.");
}

// Full-page navigation, not fetch: Google redirects back to /auth/callback.
export function startGoogleSignIn(homeBranch) {
  if (!BRANCH_OPTIONS.includes(homeBranch)) throw new Error("Choose your home branch.");
  window.location.href = `/api/auth/google?homeBranch=${homeBranch}`;
}

// Google callback only gives tokens, so ask the backend for the home branch.
export async function finishGoogleSignIn(token, refreshToken) {
  const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Google sign-in failed.");
  saveSession({ token, refreshToken, user: data.user });
}
