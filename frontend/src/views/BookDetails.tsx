import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { circulationAction } from "../api/circulation";
import type { CatalogBook as Book } from "../recommendations/recommendations";

export const branches = ["Ajax", "Oshawa", "Whitby"] as const;
export type Branch = (typeof branches)[number];

type BookDetailsProps = {
  book: Book;
  color?: string;
  holdings: { branch: Branch; status: string }[];
  warning?: string;
};

export function BookCover({ book, color, className }: { book: Book; color?: string; className: string }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (book.thumbnail && !imageFailed) {
    return <img src={book.thumbnail} alt="" className={`${className} rounded-md object-cover`} onError={() => setImageFailed(true)} />;
  }

  return (
    <div
      aria-hidden="true"
      className={`${className} grid place-items-center rounded-md p-1 text-center text-xs font-semibold text-white`}
      style={{ backgroundColor: color ?? "#315953" }}
    >
      {book.title}
    </div>
  );
}

const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4 sm:p-5";

// Stored lowercase ("oshawa"); the catalog uses display names ("Oshawa").
function storedHomeBranch(): Branch | undefined {
  const branch = localStorage.getItem("homeBranch");
  return branch ? (branch[0].toUpperCase() + branch.slice(1)) as Branch : undefined;
}

export default function BookDetails({
  book, color, holdings, warning,
}: BookDetailsProps) {
  const navigate = useNavigate();
  const homeBranch = storedHomeBranch();
  const available = holdings.filter(holding => holding.status === "Available");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);

  // The backend picks which branch sends it and always delivers to the patron's home branch.
  async function requestBook() {
    if (!localStorage.getItem("token")) {
      const { pathname, search } = window.location;
      navigate("/login", { state: { from: { pathname, search } } });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const data = await circulationAction("requests", book.isbn10);
      setResult({ text: data.message, error: false });
    } catch (err) {
      setResult({ text: err instanceof Error ? err.message : "Something went wrong.", error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article aria-labelledby="book-title" className="mt-3 space-y-4">
      <div className={`${panel} grid items-start gap-5 sm:grid-cols-[auto_minmax(0,1fr)_10rem]`}>
        <BookCover key={book.isbn10} book={book} color={color} className="h-36 w-24 sm:w-28" />
        <div>
          <span className="inline-block rounded bg-green-50 px-2 py-1 text-xs font-semibold text-green-900">
            {available.length ? `Available at ${available.length} ${available.length === 1 ? "library" : "libraries"}` : "No available copies shown"}
          </span>
          <h1 id="book-title" className="mt-2 text-3xl font-bold">{book.title}</h1>
          {book.subtitle && <p className="mt-1 text-lg text-slate-700">{book.subtitle}</p>}
          {book.author?.length ? <p className="mt-1 text-slate-700">{book.author.join(", ")}</p> : null}
          {book.categories && <p className="mt-2 text-sm text-slate-600">{[book.categories].flat().join(", ")}</p>}
          {book.description && <p className="mt-3 max-w-prose text-sm">{book.description}</p>}
        </div>
        <section className="rounded-lg bg-slate-100 p-3">
          <h2 className="font-bold">About this edition</h2>
          <dl className="mt-2 text-sm">
            <dt className="text-slate-600">ISBN-10</dt>
            <dd className="font-semibold">{book.isbn10}</dd>
            {book.average_rating != null && (
              <><dt className="mt-2 text-slate-600">Average rating</dt><dd>{book.average_rating} / 5</dd></>
            )}
            {book.ratings_count != null && (
              <><dt className="mt-2 text-slate-600">Ratings</dt><dd>{book.ratings_count.toLocaleString()}</dd></>
            )}
          </dl>
        </section>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <section aria-labelledby="book-availability" className={panel}>
          <h2 id="book-availability" className="text-xl font-bold">Library availability</h2>
          {warning && <p className="mt-2 rounded-md bg-amber-100 p-2 text-sm text-amber-900">{warning}</p>}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#edf0f8]">
                <tr>
                  <th scope="col" className="px-2 py-2">Library</th>
                  <th scope="col" className="px-2 py-2">Availability</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map(holding => (
                  <tr key={holding.branch} className="border-t border-slate-200">
                    <th scope="row" className="px-2 py-3 font-normal">
                      {holding.branch} Public Library
                      {holding.branch === homeBranch && <span className="block text-xs text-slate-600">Your home library</span>}
                    </th>
                    <td className={holding.status === "Available" ? "px-2 py-3 font-semibold text-green-900" : "px-2 py-3 text-slate-700"}>
                      {holding.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={`${panel} space-y-3`}>
          <h2 className="text-xl font-bold">Get this book</h2>
          <p className="text-sm text-slate-700">
            {homeBranch
              ? `We'll bring a copy to ${homeBranch} Public Library and hold it for you.`
              : "Log in to have a copy brought to your home library."}
          </p>
          <button
            type="button"
            onClick={requestBook}
            disabled={busy || available.length === 0}
            className="w-full rounded-md bg-[#655d5d] px-3 py-2 text-sm font-semibold text-white hover:bg-[#534b4b] disabled:opacity-50"
          >
            {available.length === 0 ? "No copies available right now" : busy ? "Requesting..." : "Request to my branch"}
          </button>
          {result && (
            <p role={result.error ? "alert" : "status"} className={`text-sm ${result.error ? "text-red-700" : "text-green-900"}`}>
              {result.text}
            </p>
          )}
        </section>
      </div>
    </article>
  );
}
