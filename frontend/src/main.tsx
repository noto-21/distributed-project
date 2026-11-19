import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

function App() {
  return (
    <main>
      <h1 className="rounded-lg bg-blue-100 p-4 text-3xl font-bold">Search Reference Library</h1>
      <p>Find books across Ajax, Oshawa, and Whitby.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
