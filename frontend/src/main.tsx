import React from "react";
import { createRoot } from "react-dom/client";
import SearchPage from "./views/SearchPage";
import MyBooksPage from "./views/MyBooksPage";
// @ts-ignore: Vite handles CSS imports during the build.
import "./index.css";

function App() {
  // Keep opening your groupmate's page at /search.
  if (window.location.pathname.replace(/\/$/, "") === "/search") {
    return <SearchPage />;
  }

  // At the main address, open your My Books page.
  return <MyBooksPage />;
}

createRoot(document.getElementById("root")!).render(<App />);
