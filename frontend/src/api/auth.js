// When a user logs in at a branch, store token, refreshToken, and homeBranch into localStorage
export async function login(branch, email, password) {
  const res = await fetch(`/${branch}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");

  // Save session values returned by tokenService.sessionFor(user)
  localStorage.setItem("accessToken", data.token);
  localStorage.setItem("refreshToken", data.refreshToken);
  localStorage.setItem("homeBranch", data.homeBranch);

  return data;
}
