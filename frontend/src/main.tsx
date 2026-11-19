import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>Search Reference Library</h1>
      <p>Find books across Ajax, Oshawa, and Whitby.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);