// Get the stuff
import { authFetch } from "./client";

const BRANCHES = ["ajax", "oshawa", "whitby"];

export async function fetchAllBranchCatalogs() {
  const currentBranch = localStorage.getItem("homeBranch");

  const requests = BRANCHES.map(async (targetBranch) => {  // request for each branch
    const res = await authFetch(`/${currentBranch}/api/circulation/branches/${targetBranch}/books`);
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
