import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import SearchPage from "./views/SearchPage";
import LoginPage from "./views/LoginPage";
import SignupPage from "./views/SignupPage";
import AuthCallbackPage from "./views/AuthCallbackPage";
import MyBooksPage from "./views/MyBooksPage";
// @ts-ignore: The bundler handles this CSS import.
import "./index.css";

// shortcut: checks the stored token only; an expired session is caught by the API (authFetch), not here.
const isSignedIn = () => Boolean(localStorage.getItem("token"));

// Pages that call the API as the signed-in user.
function ProtectedRoutes() {
  const location = useLocation();
  return isSignedIn() ? <Outlet /> : <Navigate to="/login" replace state={{ from: location }} />;
}

// Login/signup: nothing to do there once signed in.
function PublicOnlyRoutes() {
  return isSignedIn() ? <Navigate to="/" replace /> : <Outlet />;
}

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

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
    {/* One toaster for every page: action results, sign-in/out, load failures. */}
    <Toaster position="top-center" toastOptions={{ duration: 5000 }} />
  </BrowserRouter>,
);
