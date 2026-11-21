export const branches = ["Ajax", "Oshawa", "Whitby"] as const;
export const formats = ["Book", "eBook", "Audiobook"] as const;

export type Branch = (typeof branches)[number];
export type Format = (typeof formats)[number];

type Status = "Available" | "Checked out" | "No copy";

export type Edition = {
  isbn: string;
  title: string;
  author: string;
  edition: string;
  format: Format;
  color: string;
  description?: string;
  holdings: Record<Branch, Status>;
};

const littleWomenDescription =
  "Meg, Jo, Beth, and Amy March grow up in Civil War–era New England, balancing family life with their own ambitions.";

const editions: Edition[] = [
  {
    isbn: "0147514010",
    title: "Little Women",
    author: "Louisa May Alcott",
    edition: "Puffin Classics",
    format: "Book",
    color: "#315953",
    description: littleWomenDescription,
    holdings: { Ajax: "Available", Oshawa: "Available", Whitby: "Checked out" },
  },
  {
    isbn: "0486296342",
    title: "Little Women",
    author: "Louisa May Alcott",
    edition: "Dover Thrift Edition",
    format: "Book",
    color: "#647d96",
    description: littleWomenDescription,
    holdings: { Ajax: "Checked out", Oshawa: "No copy", Whitby: "Available" },
  },
  {
    isbn: "0393072193",
    title: "Little Women: Annotated Edition",
    author: "Louisa May Alcott",
    edition: "Annotated edition",
    format: "Book",
    color: "#935b53",
    description: littleWomenDescription,
    holdings: { Ajax: "Checked out", Oshawa: "No copy", Whitby: "Checked out" },
  },
  {
    isbn: "9781775412226",
    title: "Little Women",
    author: "Louisa May Alcott",
    edition: "Digital edition",
    format: "eBook",
    color: "#716387",
    description: littleWomenDescription,
    holdings: { Ajax: "No copy", Oshawa: "Available", Whitby: "No copy" },
  },
];

export function searchCatalog(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/);
  const isbn = query.replace(/[\s-]/g, "").toUpperCase();

  return editions.filter(book => {
    const text = `${book.title} ${book.author}`.toLowerCase();
    return book.isbn === isbn || words.every(word => text.includes(word));
  });
}

export function findEdition(isbn: string) {
  return editions.find(book => book.isbn === isbn);
}

type IsbnLookupResult = {
  isbn10: string;
  source: "local" | "peers";
  foundAt: {
    branch: Lowercase<Branch>;
    book: {
      isbn10: string;
      title: string;
      author: string[];
      description?: string;
    };
  }[];
  offline: Lowercase<Branch>[];
  warning?: string;
};

export async function lookupIsbn(
  query: string,
  homeBranch: Branch = "Oshawa",
): Promise<IsbnLookupResult> {
  const isbn = query.replace(/[\s-]/g, "").toUpperCase();

  if (!/^\d{9}[\dX]$/.test(isbn)) {
    throw new Error("Enter a 10-character ISBN.");
  }

  const response = await fetch(
    `/catalog-api/${homeBranch.toLowerCase()}/api/circulation/books/${encodeURIComponent(isbn)}`,
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Catalog lookup failed (HTTP ${response.status}).`);
  }

  const result: IsbnLookupResult | null = await response.json();

  if (result === null || !Array.isArray(result.foundAt)) {
    throw new Error("The server returned an unexpected catalog response.");
  }

  return result;
}