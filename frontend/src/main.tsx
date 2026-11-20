import React from "react";
import { createRoot } from "react-dom/client";
import SearchPage from "./views/SearchPage";
// @ts-ignore: Vite handles CSS imports during the build.
import "./index.css";

function App() {
  if (window.location.pathname.replace(/\/$/, "") === "/search") return <SearchPage />;

  return (
    <main className="p-4">
      <nav aria-label="Main navigation"><a className="underline" href="/search">Search</a></nav>
      <h1 className="my-3 rounded-lg bg-blue-100 p-4 text-3xl font-bold">Search Reference Library</h1>
      <p>Find books across Ajax, Oshawa, and Whitby.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
