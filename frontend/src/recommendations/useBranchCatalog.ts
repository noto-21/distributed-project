import { useEffect, useState } from "react";
import { fetchAllBranchCatalogs } from "../api/circulation";
import type { CatalogBook } from "./recommendations";

// Loads every copy from all three branch databases (My Books recommendations and Search).
export function useBranchCatalog() {
  const [catalog, setCatalog] = useState<CatalogBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [offline, setOffline] = useState<string[]>([]); // branch ids that could not be loaded

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
        setOffline(Object.keys(errors));

        if (books.length === 0) {
          setMessage(
            Object.keys(errors).length > 0
            ? "The library catalog is unavailable. Check that the library servers are running."
            : "No books are currently available across library branches."
          );
        } else if (Object.keys(errors).length > 0) {
          setMessage(`Could not reach ${Object.keys(errors).join(", ")}. Showing results from the other branches.`);
        }
      } catch {
        if (!cancelled) {
          setMessage("The library catalog is unavailable. Please try again later.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { catalog, loading, message, offline };
}
