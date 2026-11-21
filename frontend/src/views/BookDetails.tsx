import React, { useState } from "react";
import { branches } from "../api/catalog";
import type { Branch } from "../api/catalog";

type BookDetailsProps = {
  isbn: string;
  title: string;
  author: string;
  edition?: string;
  format?: string;
  color?: string;
  description?: string;
  holdings: { branch: Branch; status: string }[];
  warning?: string;
};

const homeBranch = "Oshawa";
const panel = "rounded-xl border border-[#b5bfd2] bg-white p-4 sm:p-5";

export default function BookDetails({
  isbn, title, author, edition, format, color, description, holdings, warning,
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
        <div
          aria-hidden="true"
          className="grid h-36 w-24 place-items-center rounded-md p-2 text-center text-sm font-semibold text-white sm:w-28"
          style={{ backgroundColor: color ?? "#315953" }}
        >
          {title}
        </div>
        <div>
          <span className="inline-block rounded bg-green-50 px-2 py-1 text-xs font-semibold text-green-900">
            {available.length ? `Available at ${available.length} ${available.length === 1 ? "library" : "libraries"}` : "No available copies shown"}
          </span>
          <h1 id="book-title" className="mt-2 text-3xl font-bold">{title}</h1>
          {author && <p className="mt-1 text-slate-700">{author}</p>}
          {(format || edition) && <p className="mt-2 text-sm text-slate-600">{[format, edition].filter(Boolean).join(" · ")}</p>}
          {description && <p className="mt-3 max-w-prose text-sm">{description}</p>}
        </div>
        <section className="rounded-lg bg-slate-100 p-3">
          <h2 className="font-bold">About this edition</h2>
          <dl className="mt-2 text-sm">
            <dt className="text-slate-600">ISBN</dt>
            <dd className="font-semibold">{isbn}</dd>
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
