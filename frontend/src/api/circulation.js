// Get the stuff
import { authFetch } from "./client";

const BRANCHES = ["ajax", "oshawa", "whitby"];

// POST /api/circulation/<action> { isbn10 } for "checkout", "return", "renew", "holds/cancel", "requests".
// Resolves to the backend's body (show its `message`); rejects with its error text.
export async function circulationAction(action, isbn10) {
  const res = await authFetch(`/api/circulation/${action}`, {
    method: "POST",
    body: JSON.stringify({ isbn10 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function fetchAllBranchCatalogs() {
  const homeBranch = localStorage.getItem("homeBranch");

  const requests = BRANCHES.map(async (targetBranch) => {  // request for each branch
    // Route through homeBranch if signed in, or directly to targetBranch if signed out
    const entryBranch = homeBranch || targetBranch;
    const res = await authFetch(`/${entryBranch}/api/circulation/branches/${targetBranch}/books`);
    // Main HTTP request for getting all the books
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load ${targetBranch} (${res.status})`);
    }

    const data = await res.json();
    return {
      branch: targetBranch,
      books: data.objects ?? data.books ?? []
    };
  });

  const results = await Promise.allSettled(requests);

  const catalogs = { ajax: [], oshawa: [], whitby: [] }; // your jsons
  const errors = {};

  results.forEach((result, idx) => { //  make sure each one is good
    const branch = BRANCHES[idx];
    if (result.status === "fulfilled") {
      catalogs[branch] = result.value.books;
    } else {
      errors[branch] = result.reason.message;
    }
  });

  return { catalogs, errors }; // catalogs has jsons inside of ajax, oshawa, whitby. Errors for erros
}
