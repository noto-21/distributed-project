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

  if (path === "/") return <LoginPage />;
  if (path === "/search") return <SearchPage />;
  if (path === "/login") return <LoginPage />;
  if (path === "/signup") return <SignupPage />;
  if (path === "/auth/callback") return <AuthCallbackPage />;
  if (path === "/my-books") return <MyBooksPage />;

  return <LoginPage />;
}

createRoot(document.getElementById("root")!).render(<App />);