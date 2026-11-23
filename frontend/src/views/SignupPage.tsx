import { useState, type FormEvent } from "react";
import { branches } from "../api/catalog";

const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4";
const action = "w-full rounded-md bg-[#797171] px-4 py-2 text-white hover:bg-[#655d5d]";
const field = "w-full rounded-md border border-[#9ca8bd] bg-white px-3 py-2";

export default function SignupPage() {
  const [branch, setBranch] = useState<string>(branches[0]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
            const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          homeBranch: branch.toLowerCase(),
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? "Sign up failed.");
      }

      localStorage.setItem("token", data.token);
      localStorage.setItem("refreshToken", data.refreshToken);
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#dff5f5] p-3 font-serif text-[#171717] sm:p-5">
      <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl bg-[#dce5f6] shadow-md">
        <header className="flex flex-wrap items-center justify-between gap-3 bg-white px-6 py-4">
          <a href="/" className="text-2xl font-bold">
            <span className="text-[#4f82f6]">Durham</span>Library
          </a>
          <div className="flex items-center gap-3">
            <span>Already Have an Account?</span>
            <a href="/login" className="rounded-md bg-[#797171] px-4 py-2 text-white hover:bg-[#655d5d]">
              Log In?
            </a>
          </div>
        </header>

        <main className="p-6 sm:p-10">
          <section className={`${panel} mx-auto w-full max-w-sm`}>
            <h1 className="mb-4 text-center text-3xl font-medium">Sign Up</h1>

            <form className="space-y-4" onSubmit={handleSubmit}>
              <label className="block font-bold">
                Library Branch
                <select
                  className={`${field} mt-1 font-normal`}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                >
                  {branches.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>

              <label className="block font-bold">
                Email
                <input
                  type="email"
                  required
                  placeholder="Enter Your Email"
                  className={`${field} mt-1 font-normal`}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label className="block font-bold">
                Password
                <input
                  type="password"
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  className={`${field} mt-1 font-normal`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
            
              <button type="submit" className={action} disabled={loading}>
                {loading ? "Signing up..." : "Sign Up"}
              </button>
            </form>
          </section>
        </main>

        <footer className="bg-white px-6 py-3 text-sm">DurhamLibrary · Ajax · Oshawa · Whitby</footer>
      </div>
    </div>
  );
}