import React, { useState } from "react";
import { branches } from "../api/catalog";
import type { Book, Branch } from "../api/catalog";

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

const homeBranch = "Oshawa";
const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4 sm:p-5";

export default function BookDetails({
  book, color, holdings, warning,
}: BookDetailsProps) {
  const available = holdings.filter(holding => holding.status === "Available");
  const [source, setSource] = useState(
    () => available.find(holding => holding.branch === homeBranch) ?? available[0],
  );
  const [pickup, setPickup] = useState<Branch>(homeBranch);
  const [preview, setPreview] = useState("");
  const action = source?.status === "Checked out" ? "Place hold" : "Request this book";

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
          {book.authors.length > 0 && <p className="mt-1 text-slate-700">{book.authors.join(", ")}</p>}
          {book.categories && <p className="mt-2 text-sm text-slate-600">{[book.categories].flat().join(", ")}</p>}
          {book.description && <p className="mt-3 max-w-prose text-sm">{book.description}</p>}
        </div>
        <section className="rounded-lg bg-slate-100 p-3">
          <h2 className="font-bold">About this edition</h2>
          <dl className="mt-2 text-sm">
            <dt className="text-slate-600">ISBN-10</dt>
            <dd className="font-semibold">{book.isbn10}</dd>
            {book.published_year != null && (
              <><dt className="mt-2 text-slate-600">Published</dt><dd>{book.published_year}</dd></>
            )}
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
                  <th scope="col" className="px-2 py-2 text-right">Action</th>
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
                    <td className="px-2 py-3 text-right">
                      {(holding.status === "Available" || holding.status === "Checked out") && (
                        <button
                          type="button"
                          aria-label={`Select ${holding.branch} for ${holding.status === "Checked out" ? "a hold" : "a request"}`}
                          aria-pressed={source?.branch === holding.branch}
                          className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50 aria-pressed:border-slate-600 aria-pressed:bg-slate-100"
                          onClick={() => { setSource(holding); setPreview(""); }}
                        >
                          {source?.branch === holding.branch ? "Selected" : holding.status === "Checked out" ? "Place hold" : "Select"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <form
          className={`${panel} space-y-3`}
          onSubmit={event => {
            event.preventDefault();
            if (source) setPreview(`Preview: ${action} from ${source.branch} for pickup at ${pickup}. No request was sent.`);
          }}
        >
          <h2 className="text-xl font-bold">Get this book</h2>
          <div className="rounded-md border border-slate-300 bg-[#edf0f8] p-3 text-sm">
            <p className="text-xs text-slate-600">Selected library</p>
            <p className="font-semibold">{source ? `${source.branch} Public Library` : "Choose a library"}</p>
            {source && <p className="mt-1">{source.status}</p>}
          </div>
          <label className="block text-sm font-semibold">
            Pickup library
            <select
              className="mt-1 block w-full rounded-md border border-slate-400 bg-white px-2 py-2 font-normal"
              value={pickup}
              onChange={event => { setPickup(event.currentTarget.value as Branch); setPreview(""); }}
            >
              {branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>
          <button
            type="submit"
            disabled={!source}
            className="w-full rounded-md bg-[#655d5d] px-3 py-2 text-sm font-semibold text-white hover:bg-[#534b4b] disabled:opacity-50"
          >
            {action}
          </button>
          <p className="text-xs text-slate-600">Request preview</p>
          {preview && <p role="status" className="text-sm">{preview}</p>}
        </form>
      </div>
    </article>
  );
}
