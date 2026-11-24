import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
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
  return (
    <Routes>
      <Route element={<ProtectedRoutes />}>
        <Route path="/" element={<MyBooksPage />} />
      </Route>
      <Route element={<PublicOnlyRoutes />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
      </Route>
      <Route path="/search" element={<SearchPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
