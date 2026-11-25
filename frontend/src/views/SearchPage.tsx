import React, { useEffect, useMemo, useState, type MouseEventHandler } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { clearSession } from "../api/auth";
import { useBranchCatalog } from "../recommendations/useBranchCatalog";
import type { CatalogBook } from "../recommendations/recommendations";
import BookDetails, { BookCover, branches, type Branch } from "./BookDetails";
import { authFetch } from "../api/client";

type Status = "Available" | "Checked out" | "On hold" | "In transit" | "No copy" | "Branch unreachable";
// One title across the three branches: its first copy's details plus each branch's status.
type Edition = CatalogBook & { holdings: Record<Branch, Status> };

const statusLabel: Record<string, Status> = {
  AVAILABLE: "Available",
  BORROWED: "Checked out",
  ON_HOLD: "On hold",
  IN_TRANSIT: "In transit",
};

async function getJson(url: string) {
  const res = await authFetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// Copies come from every branch database; group them by ISBN-10.
function toEditions(catalog: CatalogBook[], offline: string[]): Edition[] {
  const byIsbn = new Map<string, Edition>();
  for (const copy of catalog) {
    const id = copy.currentBranch ?? "";
    const branch = branches.find(name => name.toLowerCase() === id);
    if (!branch) continue;
    const edition = byIsbn.get(copy.isbn10) ?? {
      ...copy,
      holdings: Object.fromEntries(
        branches.map(name => [name, offline.includes(name.toLowerCase()) ? "Branch unreachable" : "No copy"]),
      ) as Record<Branch, Status>,
    };
    // Several copies at one branch: an available one wins.
    if (edition.holdings[branch] !== "Available") edition.holdings[branch] = statusLabel[copy.status ?? ""] ?? "Checked out";
    byIsbn.set(copy.isbn10, edition);
  }
  return [...byIsbn.values()];
}

const normalizeIsbn10 = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();
const isIsbn10 = (value: string) => /^\d{9}[\dX]$/.test(normalizeIsbn10(value));

// shortcut: filters the loaded branch catalogs in the browser; add a server search endpoint if catalogs grow to thousands of books.
function searchEditions(editions: Edition[], query: string) {
  const text = query.trim().toLowerCase();
  if (text == '') return editions.slice(0, 5);
  if (isIsbn10(query)) return editions.filter(book => book.isbn10.toUpperCase() === normalizeIsbn10(query));

  const words = text.split(/\s+/);
  return editions.filter(book => {
    const searchable = [book.title, book.subtitle, ...(book.author ?? []), book.categories]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every(word => searchable.includes(word));
  });
}

const historyKey = "durham-library-recent-searches";
const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4";
const action = "rounded-md bg-[#797171] px-4 py-2 text-white hover:bg-[#655d5d]";
const field = "rounded-md border border-[#9ca8bd] bg-white px-3 py-2";

function readSearchLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    query: params.get("q")?.trim() ?? "",
    bookIsbn: params.get("book"),
  };
}

export function searchUrl(query: string, isbn10?: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (isbn10) params.set("book", isbn10);
  return params.size ? `/search?${params}` : "/search";
}

function hasSession() {
  const token = localStorage.getItem("token");
  return Boolean(token && token !== "undefined" && token !== "null");
}

function readHistory(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function EditionCard({ book, query, onNavigate }: {
  book: Edition;
  query: string;
  onNavigate: MouseEventHandler<HTMLAnchorElement>;
}) {
  const available = branches.filter(branch => book.holdings[branch] === "Available").length;
  return (
    <article className={panel}>
      <div className="flex flex-wrap items-start gap-3 pb-3">
        <BookCover book={book} className="h-20 w-14" />
        <div className="min-w-36 flex-1">
          <h3 className="text-xl font-bold">{book.title}</h3>
          <p>{(book.author ?? []).join(", ")}</p>
          <p className="text-sm text-slate-600">{book.subtitle}</p>
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
        href={searchUrl(query, book.isbn10)}
        onClick={onNavigate}
        aria-label={`View details for ${book.title}${book.subtitle ? `, ${book.subtitle}` : ""}`}
        className="mt-2 block border-t border-slate-200 pt-2 text-sm underline"
      >
        View details
      </a>
    </article>
  );
}

export default function SearchPage() {
  const [username, setUsername] = useState("");
  const [{ query, bookIsbn }, setLocation] = useState(readSearchLocation);
  const { catalog, loading: catalogLoading, message: catalogMessage, offline } = useBranchCatalog();
  const editions = useMemo(() => toEditions(catalog, offline), [catalog, offline]);
  const [draft, setDraft] = useState(query);
  const [history, setHistory] = useState(readHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedLibraries, setSelectedLibraries] = useState<Branch[]>([]);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [sort, setSort] = useState("relevance");
  const [signedIn, setSignedIn] = useState(hasSession);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.all([getJson("/api/auth/me")])
      .then(([me]) => {
        if (cancelled) return;
        setUsername(me.user.name || me.user.email);
      })
      .catch((err) => {
        if (cancelled) return;
      })

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setShowAll(false);
  }, [query, selectedLibraries, availableOnly, sort]);

  useEffect(() => {
    function restoreSearch() {
      const restored = readSearchLocation();
      setLocation(restored);
      setDraft(restored.query);
      setHistoryOpen(false);
    }
    window.addEventListener("popstate", restoreSearch);
    return () => window.removeEventListener("popstate", restoreSearch);
  }, []);

  useEffect(() => {
    const syncSession = () => setSignedIn(hasSession());
    window.addEventListener("storage", syncSession);
    window.addEventListener("pageshow", syncSession);

    return () => {
      window.removeEventListener("storage", syncSession);
      window.removeEventListener("pageshow", syncSession);
    };
  }, []);

  function logOut() {
    clearSession();
    setSignedIn(false);
    toast.success("You're logged out.");
  }

  const navigateSearch: MouseEventHandler<HTMLAnchorElement> = event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    window.history.pushState(null, "", event.currentTarget.href);
    const next = readSearchLocation();
    setLocation(next);
    setDraft(next.query);
    setHistoryOpen(false);
    window.scrollTo(0, 0);
  };

  function submit(value: string) {
    const next = value.trim();
    if (!next) return;
    if (next !== query || bookIsbn) window.history.pushState(null, "", searchUrl(next));
    setLocation({ query: next, bookIsbn: null });
    setDraft(next);
    setHistoryOpen(false);
    const recent = [next, ...history.filter(item => item.toLowerCase() !== next.toLowerCase())].slice(0, 8);
    setHistory(recent);
    try {
      localStorage.setItem(historyKey, JSON.stringify(recent));
    } catch {
      // The current session still keeps its history when storage is unavailable.
    }
  }
  const matchingHistory = history.filter(item =>
    draft === query || item.toLowerCase().includes(draft.trim().toLowerCase()),
  );
  const selectedBook = bookIsbn
    ? editions.find(book => book.isbn10.toUpperCase() === normalizeIsbn10(bookIsbn))
    : undefined;
  const selectedBranches = selectedLibraries.length ? selectedLibraries : branches;

  const baseEditions = query ? searchEditions(editions, query) : editions;

  const filteredResults = baseEditions.filter(book =>
    selectedBranches.some(location =>
      availableOnly
        ? book.holdings[location] === "Available"
        : book.holdings[location] !== "No copy",
    ),
  );

  if (sort === "title") {
    filteredResults.sort((a, b) => a.title.localeCompare(b.title));
  }
  // Show filtered results; if none exist (or no query is active), fall back to the first 5 editions
  const results = useMemo(() => {
  if (!editions.length) return [];

  const activeBranches = selectedLibraries.length > 0 ? selectedLibraries : branches;
  const base = query ? searchEditions(editions, query) : editions;

  const filtered = base.filter(book =>
    activeBranches.some(location =>
      availableOnly
        ? book.holdings[location] === "Available"
        : book.holdings[location] !== "No copy"
    )
  );

  if (sort === "title") {
    filtered.sort((a, b) => a.title.localeCompare(b.title));
  }

  if (filtered.length > 0) {
    return query ? filtered : filtered.slice(0, 5);
  }

  return editions.slice(0, 5);
}, [editions, selectedLibraries, query, availableOnly, sort]);
console.log(results);
  return (
    <div className="min-h-screen bg-[#dff5f5] p-3 font-serif text-[#171717] sm:p-5">
      <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl bg-[#dce5f6] shadow-md">
        <header className="flex flex-wrap items-center justify-between gap-3 bg-white px-6 py-4">
          <Link to="/" className="text-2xl font-bold"><span className="text-[#4f82f6]">Durham</span>Library</Link>
          <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-5">
            <a href="/#my-books">My Books</a>
            <Link to="/search" className="underline" aria-current="page">Search</Link>
            <span>{username}</span>
            {signedIn ? (
              <button type="button" className={action} onClick={logOut}>Log Out</button>
            ) : (
              <>
                <Link to="/login" className="underline">Log In</Link>
                <Link to="/signup" className="underline">Sign Up</Link>
              </>
            )}
          </nav>
        </header>
        <main className="p-5 sm:p-7">
          {!bookIsbn && (
              <div className="mb-5 flex flex-wrap justify-between gap-3">
                <div><h1 className="text-3xl font-bold">Welcome, {username}</h1><p>Find books across Ajax, Oshawa and Whitby.</p></div>
                <div className={panel}><p className="text-xs uppercase">Your home branch</p><p className="font-bold">Oshawa</p></div>
              </div>
          )}
          <form role="search" onSubmit={event => { event.preventDefault(); submit(draft); }}>
            <label className="mb-1 block text-xl font-bold" htmlFor="catalog-query">Search the Catalog</label>
            <div className="flex flex-wrap gap-2">
              <div
                className="relative min-w-48 flex-1"
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setHistoryOpen(false);
                }}
                onKeyDown={event => {
                  if (event.key === "Escape") {
                    event.currentTarget.querySelector("input")?.focus();
                    setHistoryOpen(false);
                  }
                }}
              >
                <input
                  id="catalog-query"
                  type="search"
                  required
                  autoComplete="off"
                  className={`${field} w-full`}
                  value={draft}
                  onFocus={() => setHistoryOpen(true)}
                  onClick={() => setHistoryOpen(true)}
                  onChange={event => {
                    setDraft(event.currentTarget.value);
                    setHistoryOpen(true);
                  }}
                  placeholder="Search by title, author, category, or ISBN-10"
                />
                {historyOpen && matchingHistory.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-md border border-slate-300 bg-white p-2 shadow-lg">
                    <p id="recent-searches-label" className="px-2 pb-1 text-sm font-semibold text-slate-700">Recent searches</p>
                    <ul aria-labelledby="recent-searches-label">
                      {matchingHistory.map(item => (
                        <li key={item}>
                          <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-slate-100 focus-visible:bg-slate-100" onClick={() => submit(item)}>
                            {item}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <button className={action}>Search</button>
            </div>
          </form>
          <p className="mt-2 text-sm text-slate-700">Ajax Public Library · Oshawa Public Libraries · Whitby Public Library</p>
          {bookIsbn ? (
            <>
              <a href={query ? searchUrl(query) : "/"} onClick={query ? navigateSearch : undefined} className="mt-4 inline-block text-sm font-semibold underline">
                {query ? "Back to search results" : "Back to home"}
              </a>
              {selectedBook ? (
                <BookDetails
                  book={selectedBook}
                  holdings={branches.map(branch => ({ branch, status: selectedBook.holdings[branch] }))}
                  warning={catalogMessage || undefined}
                />
              ) : catalogLoading ? (
                <p className={`${panel} mt-3`} role="status">Loading book details…</p>
              ) : (
                <section className={`${panel} mt-3`}>
                  <h1 className="text-xl font-bold">Book details unavailable</h1>
                  <p>Return to the catalog to find another edition.</p>
                </section>
              )}
            </>
          ) : (
              <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
                <section aria-labelledby="results-heading">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="results-heading" className="text-xl font-bold">
                      {query ? "Search Results" : "Featured Books"}
                    </h2>
                    <select className={field} aria-label="Sort results" value={sort} onChange={event => setSort(event.target.value)}>
                      <option value="relevance">Sort by relevance</option>
                      <option value="title">Sort by title</option>
                    </select>
                  </div>
                  <p className="my-2 text-sm" role="status">
                    {catalogLoading
                      ? "Loading the catalog from all libraries…"
                      : query
                        ? `${results.length} ${results.length === 1 ? "match" : "matches"} for “${query}” · All libraries`
                        : `Showing ${results.length} featured books · All libraries`}
                  </p>
                  {catalogMessage && <p className="mb-2 rounded-md bg-amber-100 p-2 text-sm text-amber-900">{catalogMessage}</p>}
                  <div className="space-y-3">
                    {results.length ? (
                      results.map(book => (
                        <EditionCard key={book.isbn10} book={book} query={query} onNavigate={navigateSearch} />
                      ))
                    ) : (
                      <p className={panel}>No matching results. Try another title, author, category, or ISBN-10, or clear the filters.</p>
                    )}
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

                  </section>
                  <section className={panel}><h2 className="font-bold">My Borrowing</h2><a href="/#my-books" className="underline">View My Books</a></section>
                </aside>
              </div>
          )}
        </main>
        <footer className="bg-white px-6 py-3 text-sm">DurhamLibrary · Ajax · Oshawa · Whitby</footer>
      </div>
    </div>
  );
}
