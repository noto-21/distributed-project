import React, { useEffect, useState } from "react";
import { branches, findEdition, formats, lookupIsbn, searchCatalog } from "../api/catalog";
import type { Branch, Edition, Format } from "../api/catalog";
import BookDetails from "./BookDetails";

const historyKey = "durham-library-recent-searches";
const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4";
const action = "rounded-md bg-[#797171] px-4 py-2 text-white hover:bg-[#655d5d]";
const field = "rounded-md border border-[#9ca8bd] bg-white px-3 py-2";

function readSearchLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    query: params.get("q")?.trim() ?? "",
    bookIsbn: params.get("book"),
    liveBook: params.get("source") === "live",
  };
}

function searchUrl(query: string, isbn?: string, live = false) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (isbn) params.set("book", isbn);
  if (live) params.set("source", "live");
  return params.size ? `/search?${params}` : "/search";
}

function readHistory(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function EditionCard({ book, query }: { book: Edition; query: string }) {
  const available = branches.filter(branch => book.holdings[branch] === "Available").length;
  return (
    <article className={panel}>
      <div className="flex flex-wrap items-start gap-3 pb-3">
        <div aria-hidden="true" className="grid min-h-20 w-14 place-items-center rounded px-1 text-center text-xs text-white" style={{ backgroundColor: book.color }}>
          {book.title}
        </div>
        <div className="min-w-36 flex-1">
          <h3 className="text-xl font-bold">{book.title}</h3>
          <p>{book.author}</p>
          <p className="text-sm text-slate-600">{book.format} · {book.edition}</p>
        </div>
        <span className={available ? "rounded bg-green-100 px-2 py-1 text-sm text-green-900" : "rounded bg-amber-100 px-2 py-1 text-sm text-amber-900"}>
          {available ? `Available at ${available} of 3 libraries` : "No copies currently available"}
        </span>
      </div>
      <table className="w-full text-left text-sm">
        <thead><tr><th scope="col" className="pb-1">Library</th><th scope="col" className="pb-1 text-right">Status</th></tr></thead>
        <tbody>
          {branches.map(branch => (
            <tr key={branch} className="border-t border-slate-200">
              <th scope="row" className="py-2 font-normal">{branch} Public Library</th>
              <td className="py-2 text-right">
                <span className={book.holdings[branch] === "Available" ? "text-green-900" : "text-slate-700"}>{book.holdings[branch]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <a
        href={searchUrl(query, book.isbn)}
        aria-label={`View details for ${book.title}, ${book.edition}`}
        className="mt-2 block border-t border-slate-200 pt-2 text-sm underline"
      >
        View details
      </a>
    </article>
  );
}

function IsbnResults({ query, showDetails = false }: { query: string; showDetails?: boolean }) {
  const [result, setResult] =
    useState<Awaited<ReturnType<typeof lookupIsbn>> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;

    lookupIsbn(query)
      .then(data => {
        if (!ignore) setResult(data);
      })
      .catch(() => {
        if (!ignore) setError("Could not reach the catalog. Check that the backend is running.");
      });

    return () => {
      ignore = true;
    };
  }, [query]);

  const book = result?.foundAt[0]?.book;
  if (showDetails && result && book) {
    const holdings = branches.map(branch => {
      const id = branch.toLowerCase();
      let status = "No available copy";
      if (result.foundAt.some(match => match.branch === id)) {
        status = "Available";
      } else if (result.offline.includes(id as Lowercase<Branch>)) {
        status = "Branch unreachable";
      } else if (result.source === "local") {
        status = "Not checked";
      }
      return { branch, status };
    });

    return (
      <BookDetails
        isbn={book.isbn10}
        title={book.title}
        author={book.author.join(", ")}
        description={book.description}
        holdings={holdings}
        warning={result.warning}
      />
    );
  }

  return (
    <section className={`${panel} mt-5`} aria-labelledby="isbn-results">
      <h2 id="isbn-results" className="text-xl font-bold">Live ISBN Results</h2>

      {error && <p role="alert">{error}</p>}
      {!result && !error && <p role="status">Checking availability…</p>}

      {result && (
        <>
          {result.warning && <p role="status">{result.warning}</p>}

          {result.foundAt.length === 0 ? (
            <p>No available copies were found for ISBN {result.isbn10}.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {result.foundAt.map(({ branch, book }) => (
                <li key={branch}>
                  <strong>{book.title}</strong>
                  <p>{book.author.join(", ")}</p>
                  <p className="capitalize">Available at {branch}</p>
                </li>
              ))}
            </ul>
          )}
          {!showDetails && book && (
            <a href={searchUrl(query, result.isbn10, true)} className="mt-3 inline-block underline">
              View details
            </a>
          )}
        </>
      )}
    </section>
  );
}
export default function SearchPage() {
  const [{ query, bookIsbn, liveBook }, setLocation] = useState(readSearchLocation);
  const [draft, setDraft] = useState(query);
  const [history, setHistory] = useState(readHistory);
  const [selectedFormats, setSelectedFormats] = useState<Format[]>([]);
  const [selectedLibraries, setSelectedLibraries] = useState<Branch[]>([]);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [sort, setSort] = useState("relevance");

  useEffect(() => {
    function restoreSearch() {
      const restored = readSearchLocation();
      setLocation(restored);
      setDraft(restored.query);
    }
    window.addEventListener("popstate", restoreSearch);
    return () => window.removeEventListener("popstate", restoreSearch);
  }, []);

  function submit(value: string) {
    const next = value.trim();
    if (!next) return;
    if (next !== query || bookIsbn) window.history.pushState(null, "", searchUrl(next));
    setLocation({ query: next, bookIsbn: null, liveBook: false });
    setDraft(next);
    const recent = [next, ...history.filter(item => item.toLowerCase() !== next.toLowerCase())].slice(0, 8);
    setHistory(recent);
    try {
      localStorage.setItem(historyKey, JSON.stringify(recent));
    } catch {
      // The current session still keeps its history when storage is unavailable.
    }
  }
  const isIsbnSearch = /^\d{9}[\dX]$/i.test(query.replace(/[\s-]/g, ""));
  const selectedBook = bookIsbn && !liveBook ? findEdition(bookIsbn) : undefined;
  const selectedBranches = selectedLibraries.length ? selectedLibraries : branches;

  const results = query
    ? searchCatalog(query).filter(book =>
        (selectedFormats.length === 0 || selectedFormats.includes(book.format)) &&
        selectedBranches.some(location =>
          availableOnly
            ? book.holdings[location] === "Available"
            : book.holdings[location] !== "No copy",
        ),
      )
    : [];
  if (sort === "title") results.sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="min-h-screen bg-[#dff5f5] p-3 font-serif text-[#171717] sm:p-5">
      <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl bg-[#dce5f6] shadow-md">
        <header className="flex flex-wrap items-center justify-between gap-3 bg-white px-6 py-4">
          <a href="/" className="text-2xl font-bold"><span className="text-[#4f82f6]">Durham</span>Library</a>
          <nav aria-label="Main navigation" className="flex gap-5">
            <a href="/#my-books">My Books</a>
            <a href="/search" className="underline" aria-current="page">Search</a>
          </nav>
        </header>
        <main className="p-5 sm:p-7">
          {!bookIsbn && (
              <div className="mb-5 flex flex-wrap justify-between gap-3">
                <div><h1 className="text-3xl font-bold">Welcome, Username</h1><p>Find books across Ajax, Oshawa and Whitby.</p></div>
                <div className={panel}><p className="text-xs uppercase">Your home branch</p><p className="font-bold">Oshawa</p></div>
              </div>
          )}
          <form role="search" onSubmit={event => { event.preventDefault(); submit(draft); }}>
            <label className="mb-1 block text-xl font-bold" htmlFor="catalog-query">Search the Catalog</label>
            <div className="flex flex-wrap gap-2">
              <input id="catalog-query" type="search" required className={`${field} min-w-48 flex-1`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Search by title, author, or ISBN" />
              <button className={action}>Search</button>
            </div>
          </form>
          <p className="mt-2 text-sm text-slate-700">Ajax Public Library · Oshawa Public Libraries · Whitby Public Library</p>
          {bookIsbn ? (
            <>
              <a href={searchUrl(query)} className="mt-4 inline-block text-sm font-semibold underline">
                {query ? "Back to search results" : "Back to search"}
              </a>
              {liveBook ? (
                <IsbnResults key={bookIsbn} query={bookIsbn} showDetails />
              ) : selectedBook ? (
                <BookDetails
                  isbn={selectedBook.isbn}
                  title={selectedBook.title}
                  author={selectedBook.author}
                  edition={selectedBook.edition}
                  format={selectedBook.format}
                  color={selectedBook.color}
                  description={selectedBook.description}
                  holdings={branches.map(branch => ({ branch, status: selectedBook.holdings[branch] }))}
                />
              ) : (
                <section className={`${panel} mt-3`}>
                  <h1 className="text-xl font-bold">Book details unavailable</h1>
                  <p>Return to the catalog to find another edition.</p>
                </section>
              )}
            </>
          ) : (
            <>
              {isIsbnSearch ? (
                <IsbnResults key={query} query={query} />
              ) : query ? (
                <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
                  <section aria-labelledby="results-heading">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 id="results-heading" className="text-xl font-bold">Search Results</h2>
                      <select className={field} aria-label="Sort results" value={sort} onChange={event => setSort(event.target.value)}>
                        <option value="relevance">Sort by relevance</option><option value="title">Sort by title</option>
                      </select>
                    </div>
                    <p className="my-2 text-sm" role="status">{results.length} {results.length === 1 ? "match" : "matches"} for “{query}” · Sample catalog</p>
                    <div className="space-y-3">
                      {results.length ? results.map(book => <EditionCard key={book.isbn} book={book} query={query} />) :
                        <p className={panel}>No matching results. Try another title, author, or ISBN, or clear the filters.</p>}
                    </div>
                  </section>
                  <aside className="space-y-3">
                    <section className={`${panel} space-y-3`}>
                      <div className="flex justify-between">
                        <h2 className="font-bold">Refine search</h2>
                        <button
                          type="button"
                          className="underline"
                          onClick={() => {
                            setSelectedFormats([]);
                            setSelectedLibraries([]);
                            setAvailableOnly(false);
                          }}
                        >
                          Reset
                        </button>
                      </div>

                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={availableOnly}
                          onChange={event => setAvailableOnly(event.currentTarget.checked)}
                        />
                        Available now
                      </label>

                      <fieldset className="space-y-1 border-t border-slate-200 pt-2">
                        <legend className="pr-2 font-semibold">Library</legend>
                        {branches.map(name => (
                          <label key={name} className="flex cursor-pointer items-center gap-2 py-1">
                            <input
                              type="checkbox"
                              checked={selectedLibraries.includes(name)}
                              onChange={event => {
                                const checked = event.currentTarget.checked;
                                setSelectedLibraries(current =>
                                  checked ? [...current, name] : current.filter(item => item !== name),
                                );
                              }}
                            />
                            {name}
                          </label>
                        ))}
                      </fieldset>

                      <fieldset className="space-y-1 border-t border-slate-200 pt-2">
                        <legend className="pr-2 font-semibold">Format</legend>
                        {formats.map(name => (
                          <label key={name} className="flex cursor-pointer items-center gap-2 py-1">
                            <input
                              type="checkbox"
                              checked={selectedFormats.includes(name)}
                              onChange={event => {
                                const checked = event.currentTarget.checked;
                                setSelectedFormats(current =>
                                  checked ? [...current, name] : current.filter(item => item !== name),
                                );
                              }}
                            />
                            {name}
                          </label>
                        ))}
                      </fieldset>
                    </section>
                    <section className={panel}><h2 className="font-bold">My Borrowing</h2><a href="/#my-books" className="underline">View My Books</a></section>
                  </aside>
                </div>
              ) : (
                <section className={`${panel} mt-5`}>
                  <h2 className="mb-2 text-xl font-bold">Recent Searches</h2>
                  {history.length ? <ul className="flex flex-wrap gap-2">{history.map(item => <li key={item}><button type="button" className={field} onClick={() => submit(item)}>{item}</button></li>)}</ul>
                    : <p className="text-slate-600">Your recent searches will appear here.</p>}
                </section>
              )}
            </>
          )}
        </main>
        <footer className="bg-white px-6 py-3 text-sm">DurhamLibrary · Ajax · Oshawa · Whitby</footer>
      </div>
    </div>
  );
}
