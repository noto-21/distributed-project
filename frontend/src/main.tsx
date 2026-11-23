import React from "react";
import { createRoot } from "react-dom/client";
import SearchPage from "./views/SearchPage";
<<<<<<< HEAD
import LoginPage from "./views/LoginPage";
import SignupPage from "./views/SignupPage";
import AuthCallbackPage from "./views/AuthCallbackPage";
=======
import MyBooksPage from "./views/MyBooksPage";
>>>>>>> origin/my-books
// @ts-ignore: Vite handles CSS imports during the build.
import "./index.css";

function App() {
<<<<<<< HEAD
  const path = window.location.pathname.replace(/\/$/, "");

  if (path === "/search") return <SearchPage />;
  if (path === "/login") return <LoginPage />;
  if (path === "/signup") return <SignupPage />;
  if (path === "/auth/callback") return <AuthCallbackPage />;

  return (
    <main className="p-4">
      <nav aria-label="Main navigation" className="flex gap-4">
        <a className="underline" href="/search">Search</a>
        <a className="underline" href="/login">Log In</a>
        <a className="underline" href="/signup">Sign Up</a>
      </nav>
      <h1 className="my-3 rounded-lg bg-blue-100 p-4 text-3xl font-bold">Search Reference Library</h1>
      <p>Find books across Ajax, Oshawa, and Whitby.</p>
    </main>
  );
=======
  // Keep opening your groupmate's page at /search.
  if (window.location.pathname.replace(/\/$/, "") === "/search") {
    return <SearchPage />;
  }

  // At the main address, open your My Books page.
  return <MyBooksPage />;
>>>>>>> origin/my-books
}

createRoot(document.getElementById("root")!).render(<App />);