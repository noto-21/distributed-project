import React, { useEffect, useState } from "react";
import { useBranchCatalog } from "../recommendations/useBranchCatalog";
import { recommendBooks } from "../recommendations/recommendations";


// Fields returned for a single catalog book by the library backend.
type LibraryStatus = "AVAILABLE" | "BORROWED" | "IN_TRANSIT" | "ON_HOLD";

type LibraryBook = {
  _id: string;
  isbn10: string;
  title: string;
  author: string[];
  categories?: string;
  thumbnail?: string;
  description?: string;
  average_rating?: number;
  ratings_count?: number;
  currentBranch: string;
  originBranch?: string;
  status: LibraryStatus;
  activeTransferId?: string | null;
  borrowedBy?: string | null;
  heldFor?: string | null;
  holdExpiresAt?: string | null;
};

// Loans are separate database records, keyed by ISBN-10.
// Dates are ISO strings, as returned by the API.
type Loan = {
  isbn10: string;
  status: "ACTIVE" | "RETURNED";
  createdAt: string;
  dueAt: string;
};

// The My Books view combines catalog details with a user's loan (if any).
type MyBook = LibraryBook & { loan: Loan | null };

// Rules shared throughout the page.
const MAX_BOOKS = 3;
const ONE_DAY = 24 * 60 * 60 * 1000;
const LOAN_DAYS = 14;

// One staff recommendation.
const staffPicks = [
  {
    isbn10: "0147514010",
    title: "Little Women",
    staffName: "Maya",
  },
];

// One sample popular book.
const hotRightNow = [
  {
    isbn10: "054792822X",
    title: "The Hobbit",
  },
];

// Branch IDs are lowercase in the API, but capitalized on screen.
function displayBranch(branch: string) {
  return branch.charAt(0).toUpperCase() + branch.slice(1);
}

// Calculate a loan's remaining time and progress-bar percentage.
function getLoanTiming(
  borrowedAt: number,
  dueAt: number,
  now: number
) {
  const remaining = dueAt - now;

  // A loan becomes overdue when its deadline is reached.
  const overdue = remaining <= 0;

  // Warn the user during the final three days.
  const dueSoon = !overdue && remaining <= 3 * ONE_DAY;

  // Protect against a zero-length borrowing period.
  const totalTime = Math.max(1, dueAt - borrowedAt);

  // Keep the bar between 0% and 100%.
  const percentage = Math.min(
    100,
    Math.max(0, (remaining / totalTime) * 100)
  );

  const daysRemaining = Math.ceil(
    Math.max(0, remaining) / ONE_DAY
  );

  const daysOverdue = Math.floor(
    Math.max(0, -remaining) / ONE_DAY
  );

  let label: string;

  if (overdue) {
    label =
      daysOverdue >= 1
        ? `${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} overdue`
        : "Overdue by less than a day";
  } else {
    label =
      `${daysRemaining} ` +
      `${daysRemaining === 1 ? "day" : "days"} remaining`;
  }

  return { overdue, dueSoon, percentage, label };
}

// Both sidebar sections can use this same cover component.
function SidebarCover({
  isbn10,
  title,
}: {
  isbn10: string;
  title: string;
}) {
  // Show a text cover if the image cannot load.
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div className="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-[#DDE7F8]">
      {imageFailed ? (
        <span className="p-2 text-center text-xs font-bold">
          {title}
        </span>
      ) : (
        <img
          src={`https://covers.openlibrary.org/b/isbn/${isbn10}-M.jpg?default=false`}
          alt={`Cover of ${title}`}
          width={64}
          height={96}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

export default function MyBooksPage() {
  
  useEffect(() => {
    document.title = "My Books | Durham Library";
  }, []);


  // Sample account. 
  const username = "Cameron";
  const homeBranch = "Oshawa";

  // Store the current time so the page can update as deadlines pass.
  const [now, setNow] = useState(() => Date.now());

  // Sample data ONLY: the fields now match the library catalog, and dates
  // live in a separate loan object. Replace the demo records with API data later.
  const [books, setBooks] = useState<MyBook[]>(() => [
    {
      _id: "mock-little-women",
      isbn10: "0147514010",
      title: "Little Women",
      author: ["Louisa May Alcott"],
      categories: "Classic fiction",
      currentBranch: homeBranch.toLowerCase(),
      originBranch: homeBranch.toLowerCase(),
      status: "BORROWED",
      loan: {
        isbn10: "0147514010",
        status: "ACTIVE",
        createdAt: new Date(now - 12 * ONE_DAY).toISOString(),
        dueAt: new Date(now + 2 * ONE_DAY).toISOString(),
      },
    },
    {
      _id: "mock-hobbit",
      isbn10: "054792822X",
      title: "The Hobbit",
      author: ["J. R. R. Tolkien"],
      categories: "Fantasy",
      currentBranch: homeBranch.toLowerCase(),
      originBranch: homeBranch.toLowerCase(),
      status: "BORROWED",
      loan: {
        isbn10: "054792822X",
        status: "ACTIVE",
        createdAt: new Date(now - 16 * ONE_DAY).toISOString(),
        dueAt: new Date(now - 2 * ONE_DAY).toISOString(),
      },
    },
    {
      _id: "mock-pride-and-prejudice",
      isbn10: "0141439513",
      title: "Pride and Prejudice",
      author: ["Jane Austen"],
      categories: "Classic fiction",
      currentBranch: homeBranch.toLowerCase(),
      originBranch: homeBranch.toLowerCase(),
      status: "BORROWED",
      loan: null, // Demo case: loan details have not loaded yet.
    },
  ]);

  // Check the time once per second.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    // Stop this timer when the user leaves the page.
    return () => window.clearInterval(timer);
  }, []);

  // Requested, transferring, and borrowed books all use one slot.
  const slotsUsed = books.length;

  const borrowedCount = books.filter(
    (book) => book.status === "BORROWED"
  ).length;


  // Get the catalog from all three library branches.
  const { catalog, loading, message } = useBranchCatalog();

  // Generate recommendations from the catalog and My Books.
  const recommendedBooks = recommendBooks(catalog, books);



  // Borrow a book only when it is ready at the home library.
  function checkoutBook(bookId: string) {
    const checkoutTime = Date.now();
    setNow(checkoutTime);

    setBooks((currentBooks) => {
      const currentBorrowedCount = currentBooks.filter(
        (book) => book.status === "BORROWED"
      ).length;

      if (currentBorrowedCount >= MAX_BOOKS) {
        return currentBooks;
      }

      return currentBooks.map((book): MyBook => {
        // Check the selected book's status and location.
        if (
          book._id === bookId &&
          book.status === "AVAILABLE" &&
          book.currentBranch.toLowerCase() === homeBranch.toLowerCase()
        ) {
          return {
            ...book,
            status: "BORROWED",
            loan: {
              isbn10: book.isbn10,
              status: "ACTIVE",
              createdAt: new Date(checkoutTime).toISOString(),
              dueAt: new Date(checkoutTime + LOAN_DAYS * ONE_DAY).toISOString(),
            },
          };
        }

        // Leave every other book unchanged.
        return book;
      });
    });
  }

  // Remove a borrowed book and free its slot.
  function returnBook(bookId: string) {
    setBooks((currentBooks) =>
      currentBooks.filter(
        (book) => book._id !== bookId || book.status !== "BORROWED"
      )
    );
  }

  // Remove a request that has not been checked out.
  function cancelRequest(bookId: string) {
    setBooks((currentBooks) =>
      currentBooks.filter(
        (book) => book._id !== bookId || book.status === "BORROWED"
      )
    );
  }

  // Demo rule: add 14 days to the current due date.
  // For overdue books, give 14 days from today.
  function renewBook(bookId: string) {
    const renewalTime = Date.now();
    setNow(renewalTime);

    setBooks((currentBooks) =>
      currentBooks.map((book): MyBook => {
        if (
          book._id === bookId &&
          book.status === "BORROWED" &&
          book.loan !== null
        ) {
          return {
            ...book,
            loan: {
              ...book.loan,
              dueAt: new Date(
                Math.max(new Date(book.loan.dueAt).getTime(), renewalTime) +
                LOAN_DAYS * ONE_DAY
              ).toISOString(),
            },
          };
        }

        return book;
      })
    );
  }

  return (
    <div className="min-h-screen bg-[#E1F7F7] p-4 font-serif text-black">
      <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl bg-[#DDE7F8] shadow-lg">

        {/* Header and navigation. */}
        <header className="flex flex-wrap items-center justify-between gap-4 bg-white px-6 py-4">
          <a href="/" className="text-2xl font-bold"><span className="text-[#4f82f6]">Durham</span>Library</a>

          <nav
            aria-label="Main navigation"
            className="flex flex-wrap items-center gap-5"
          >
            <a href="/" className="underline" aria-current="page">
              Home
            </a>

            <a href="/search">Search</a>

            <span>{username}</span>

            {/* Your teammate will connect logout to the login system. */}
            <button
              type="button"
              className="cursor-pointer rounded-md bg-[#777170] px-4 py-2 text-white hover:bg-[#655d5d]"
              onClick={() => {
                localStorage.removeItem("token");
                localStorage.removeItem("refreshToken");
                window.location.href = "/login";
              }}
            >
              Log Out
            </button>
          </nav>
        </header>

        {/* Two columns on larger screens, one on smaller screens. */}
        <main className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <section id="my-books">
              <h1 className="text-4xl font-bold">My Books</h1>

              <p className="mt-2 text-gray-600">
                Your requested and borrowed books.
              </p>

              <div className="mt-5 space-y-4">

                {/* Show this message if all books have been removed. */}
                {books.length === 0 && (
                  <div className="rounded-xl border border-gray-400 bg-white p-6">
                    <p>You have no books yet.</p>

                    <a
                      href="/search"
                      className="mt-3 inline-block rounded-md bg-[#777170] px-4 py-2 text-white"
                    >
                      Find a book
                    </a>
                  </div>
                )}

                {books.map((book) => {
                  // Calculate timing only for a valid borrowed book.
                  const timing =
                    book.status === "BORROWED" &&
                    book.loan?.status === "ACTIVE"
                      ? getLoanTiming(
                          new Date(book.loan.createdAt).getTime(),
                          new Date(book.loan.dueAt).getTime(),
                          now
                        )
                      : null;

                  // Compare library names without worrying about capital letters.
                  const atHome =
                    book.currentBranch.toLowerCase() === homeBranch.toLowerCase();

                  return (
                    <article
                      key={book._id}
                      className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-400 bg-white p-5"
                    >
                      {/* Use the backend cover when present; keep the text fallback. */}
                      {book.thumbnail ? (
                        <img
                          src={book.thumbnail.replace(/^http:/, "https:")}
                          alt={`Cover of ${book.title}`}
                          className="h-28 w-20 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div
                          aria-hidden="true"
                          className="flex h-28 w-20 shrink-0 items-center justify-center rounded bg-[#DDE7F8] p-2 text-center text-sm font-bold"
                        >
                          {book.title}
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        <h2 className="text-xl font-bold">{book.title}</h2>
                        <p>{book.author.join(", ") || "Author unavailable"}</p>

                        <p className="mt-1 text-sm text-gray-600">
                          {book.categories}
                        </p>

                        <p className="mt-1 text-sm font-bold">
                          Library: {displayBranch(book.currentBranch)}
                        </p>

                        {/* Display the countdown bar only after checkout. */}
                        {timing !== null && book.loan !== null && (
                          <div className="mt-3 max-w-sm">
                            <div
                              role="progressbar"
                              aria-label={`Borrowing time remaining for ${book.title}`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(timing.percentage)}
                              aria-valuetext={timing.label}
                              className={`h-2 overflow-hidden rounded-full ${
                                timing.overdue
                                  ? "bg-red-200"
                                  : "bg-gray-200"
                              }`}
                            >
                              {/* Blue normally, amber near the due date. */}
                              <div
                                className={`h-full ${
                                  timing.overdue
                                    ? "bg-red-600"
                                    : timing.dueSoon
                                      ? "bg-amber-600"
                                      : "bg-[#5485F7]"
                                }`}
                                style={{
                                  width: `${timing.percentage}%`,
                                }}
                              />
                            </div>

                            <p
                              className={`mt-2 text-sm font-bold ${
                                timing.overdue
                                  ? "text-red-700"
                                  : timing.dueSoon
                                    ? "text-amber-700"
                                    : "text-gray-700"
                              }`}
                            >
                              {timing.label}
                            </p>

                            <p className="mt-1 text-sm text-gray-600">
                              Due:{" "}
                              {new Date(book.loan.dueAt).toLocaleDateString(
                                "en-CA"
                              )}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Book status and available actions. */}
                      <div className="space-y-3">

                      

                      {/* Enable this when the book detail screen is available. */}
                      <button
                        type="button"
                        disabled
                        className="block cursor-not-allowed text-sm text-gray-400"
                      >
                        View Details
                      </button>

                      {/* Choose a label and colour based on the book's current state. */}
                      <p
                        role="status"
                        className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${
                          timing?.overdue
                            ? "bg-red-100 text-red-700"
                            : timing?.dueSoon
                              ? "bg-amber-100 text-amber-700"
                              : book.status === "BORROWED"
                                ? "bg-gray-100 text-gray-700"
                                : book.status === "IN_TRANSIT"
                                  ? "bg-blue-100 text-blue-700"
                                  : book.status === "ON_HOLD"
                                    ? "bg-violet-100 text-violet-800"
                                    : atHome
                                    ? "bg-green-100 text-green-800"
                                    : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {/* Show a spinning circle only while the book is transferring. */}
                        {book.status === "IN_TRANSIT" && (
                          <span
                            aria-hidden="true"
                            className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
                          />
                        )}

                        {timing?.overdue
                          ? "⚑ Overdue"
                          : timing?.dueSoon
                            ? "Due soon"
                            : book.status === "BORROWED"
                              ? "Checked out"
                              : book.status === "IN_TRANSIT"
                                ? `Transferring to ${homeBranch}…`
                                : book.status === "ON_HOLD"
                                  ? "On hold"
                                  : atHome
                                    ? "Available locally"
                                    : `Transfer required from ${displayBranch(book.currentBranch)}`}
                      </p>

                        {book.status === "BORROWED" ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => returnBook(book._id)}
                              className="rounded-md bg-[#777170] px-4 py-2 text-white"
                            >
                              Return
                            </button>

                            <button
                              type="button"
                              onClick={() => renewBook(book._id)}
                              className="rounded-md border border-[#777170] px-4 py-2 text-[#777170]"
                            >
                              Renew
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => checkoutBook(book._id)}
                            disabled={
                              book.status !== "AVAILABLE" ||
                              !atHome ||
                              borrowedCount >= MAX_BOOKS
                            }
                            className="rounded-md bg-[#777170] px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Checkout
                          </button>

                            <button
                              type="button"
                              onClick={() => cancelRequest(book._id)}
                              className="rounded-md border border-[#777170] px-4 py-2 text-[#777170]"
                            >
                              Cancel Request
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            {/* Recommendation cards will be added next. */}
            <section className="mt-8">
              <h2 className="text-3xl font-bold">Recommendations</h2>

              <p className="mt-2 text-gray-600">
                Discover your next read.
              </p>
              

              {loading && (
                <p className="mt-4 text-gray-600">
                  Loading recommendations...
                </p>
              )}

              {message && (
                <p className="mt-4 text-gray-600" role="status">
                  {message}
                </p>
              )}



              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {recommendedBooks.map((book) => (
                  <div
                    key={book.isbn10}
                    className="flex items-center gap-4 rounded-xl border border-gray-400 bg-white p-4"
                  >
                    {/* Book cover */}
                    {book.thumbnail && (
                      <img
                        src={book.thumbnail.replace("http://", "https://")}
                        alt={book.title}
                        className="h-36 w-24 shrink-0 rounded object-cover"
                      />
                    )}

                    {/* Book information */}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-lg font-bold">
                        {book.title}
                      </h3>

                      <p className="mt-1 text-sm text-gray-600">
                        {book.categories}
                      </p>

                      <p className="mt-3 text-sm">
                        {book.reason}
                      </p>

                      <p className="mt-3 text-sm font-semibold">
                        Library: {displayBranch(book.currentBranch ?? "Unknown")}
                      </p>
                    </div>
                  </div>
                ))}
              </div>


            </section>
          </div>

          <aside className="space-y-4">
            <section className="rounded-xl border border-gray-400 bg-white p-5">
              <h2 className="text-sm uppercase">Your home library</h2>

              <p className="mt-2 text-2xl font-bold">{homeBranch}</p>

              <p className="mt-1 text-sm text-gray-600">
                Saved to your account.
              </p>
            </section>

            <section className="rounded-xl border border-gray-400 bg-white p-5">
              <h2 className="text-xl font-bold">My Borrowing</h2>

              <p className="mt-2">
                {slotsUsed} / {MAX_BOOKS} book slots used
              </p>

              <p className="mt-1 text-sm text-gray-600">
                {borrowedCount} checked out
              </p>

              {slotsUsed >= MAX_BOOKS && (
                <p className="mt-2 text-sm text-red-700">
                  Return a book or cancel a request before requesting another.
                </p>
              )}
            </section>

            {/* Staff selections: cover, title, and the staff member's name. */}
            <section className="rounded-xl border border-gray-400 bg-white p-5">
              <h2 className="text-xl font-bold">Staff Picks</h2>

              <div className="mt-4 space-y-4">
                {staffPicks.map((book) => (
                  <article
                    key={book.isbn10}
                    className="flex items-start gap-3"
                  >
                    <SidebarCover isbn10={book.isbn10} title={book.title} />

                    <div className="min-w-0">
                      <h3 className="font-bold">{book.title}</h3>

                      <p className="mt-2 text-sm text-gray-600">
                        Picked by {book.staffName}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {/* Sample popular selections: cover and title. */}
            <section className="rounded-xl border border-gray-400 bg-white p-5">
              <h2 className="text-xl font-bold">Hot Right Now</h2>

              <div className="mt-4 space-y-4">
                {hotRightNow.map((book) => (
                  <article
                    key={book.isbn10}
                    className="flex items-start gap-3"
                  >
                    <SidebarCover isbn10={book.isbn10} title={book.title} />

                    <h3 className="min-w-0 font-bold">
                      {book.title}
                    </h3>
                  </article>
                ))}
              </div>
            </section>
          </aside>
        </main>

        <footer className="bg-white px-6 py-3 text-sm">
          DurhamLibrary · Ajax · Oshawa · Whitby
        </footer>
      </div>
    </div>
  );
}