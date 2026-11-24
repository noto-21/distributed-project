import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BRANCH_OPTIONS, register } from "../api/auth";

const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4";
const action = "w-full rounded-md bg-[#797171] px-4 py-2 text-white hover:bg-[#655d5d]";
const field = "w-full rounded-md border border-[#9ca8bd] bg-white px-3 py-2";

export default function SignupPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [homeBranch, setHomeBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      await register({ name: username.trim(), email, password, homeBranch });
      navigate("/", { replace: true });
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
          <Link to="/" className="text-2xl font-bold">
            <span className="text-[#4f82f6]">Durham</span>Library
          </Link>
          <div className="flex items-center gap-3">
            <span>Already Have an Account?</span>
            <Link to="/login" className="rounded-md bg-[#797171] px-4 py-2 text-white hover:bg-[#655d5d]">
              Log In?
            </Link>
          </div>
        </header>

        <main className="p-6 sm:p-10">
          <section className={`${panel} mx-auto w-full max-w-sm`}>
            <h1 className="mb-4 text-center text-3xl font-medium">Sign Up</h1>

            <form className="space-y-4" onSubmit={handleSubmit}>
              <label className="block font-bold">
                Username
                <input
                  type="text"
                  required
                  placeholder="Enter Your Username"
                  className={`${field} mt-1 font-normal`}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
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

              <label className="block font-bold">
                Home Branch
                <select
                  required
                  className={`${field} mt-1 font-normal`}
                  value={homeBranch}
                  onChange={(event) => setHomeBranch(event.target.value)}
                >
                  <option value="" disabled>Choose a branch</option>
                  {BRANCH_OPTIONS.map((branch) => (
                    <option key={branch} value={branch}>{branch[0].toUpperCase() + branch.slice(1)}</option>
                  ))}
                </select>
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