import React from "react";
import { createRoot } from "react-dom/client";
import SearchPage from "./views/SearchPage";
import LoginPage from "./views/LoginPage";
import SignupPage from "./views/SignupPage";
import AuthCallbackPage from "./views/AuthCallbackPage";
import MyBooksPage from "./views/MyBooksPage";
// @ts-ignore: The bundler handles this CSS import.
import "./index.css";

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";


  if (path === "/search") return <SearchPage />;
  if (path === "/login") return <LoginPage />;
  if (path === "/signup") return <SignupPage />;
  if (path === "/auth/callback") return <AuthCallbackPage />;

  return <MyBooksPage />;
  }

  return (
    <main className="p-4">
      <nav aria-label="Main navigation" className="flex gap-4">
        <a className="underline" href="/search">Search</a>
        <a className="underline" href="/my-books">My Books</a>
        <a className="underline" href="/login">Log In</a>
        <a className="underline" href="/signup">Sign Up</a>
      </nav>
      <h1 className="my-3 rounded-lg bg-blue-100 p-4 text-3xl font-bold">
        Search Reference Library
      </h1>
      <p>Find books across Ajax, Oshawa, and Whitby.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);