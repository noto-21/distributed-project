import { useEffect, useState } from "react";
import { fetchAllBranchCatalogs } from "../api/circulation";
import type { CatalogBook } from "./recommendations";

// Loads all three libraries using Liam's existing API helper.
export function useBranchCatalog() {
  const [catalog, setCatalog] = useState<CatalogBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { catalogs, errors } = await fetchAllBranchCatalogs();
        if (cancelled) return;

       
        const allBooks = Object.values(catalogs).flat() as CatalogBook[];

        const books = allBooks.filter(
        (book) =>
            book != null &&
            typeof book.isbn10 === "string" &&
            typeof book.title === "string"
        );

        setCatalog(books);

        if (books.length === 0) {
          setMessage("Recommendations are unavailable. Sign in and check that the library servers are running.");
        } else if (Object.keys(errors).length > 0) {
          setMessage("Some library branches could not be reached. Showing available results.");
        }
      } catch {
        if (!cancelled) {
          setMessage("Recommendations are unavailable. Please try again later.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { catalog, loading, message };
}
