export const branches = ["Ajax", "Oshawa", "Whitby"] as const;
export type Branch = (typeof branches)[number];

export type Book = {
  isbn10: string;
  title: string;
  subtitle?: string;
  authors: string[];
  categories?: string | string[];
  thumbnail?: string;
  description?: string;
  published_year?: number;
  average_rating?: number;
  ratings_count?: number;
};

type Status = "Available" | "Checked out" | "No copy";

export type Edition = Book & {
  color: string;
  holdings: Record<Branch, Status>;
};

const littleWomenDescription =
  "Meg, Jo, Beth, and Amy March grow up in Civil War-era New England, balancing family life with their own ambitions.";

const editions: Edition[] = [
  {
    isbn10: "0147514010",
    title: "Little Women",
    subtitle: "Puffin Classics",
    authors: ["Louisa May Alcott"],
    categories: ["Classic fiction"],
    description: littleWomenDescription,
    color: "#315953",
    holdings: { Ajax: "Available", Oshawa: "Available", Whitby: "Checked out" },
  },
  {
    isbn10: "0486296342",
    title: "Little Women",
    subtitle: "Dover Thrift Edition",
    authors: ["Louisa May Alcott"],
    categories: ["Classic fiction"],
    description: littleWomenDescription,
    color: "#647d96",
    holdings: { Ajax: "Checked out", Oshawa: "No copy", Whitby: "Available" },
  },
  {
    isbn10: "0393072193",
    title: "Little Women: Annotated Edition",
    authors: ["Louisa May Alcott"],
    categories: ["Classic fiction"],
    description: littleWomenDescription,
    color: "#935b53",
    holdings: { Ajax: "Checked out", Oshawa: "No copy", Whitby: "Checked out" },
  },
];

export function getFeaturedBooks() {
  return editions.slice(0, 5);
}

export function normalizeIsbn10(value: string) {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function isIsbn10(value: string) {
  return /^\d{9}[\dX]$/.test(normalizeIsbn10(value));
}

export function findEdition(isbn10: string) {
  return editions.find(book => book.isbn10 === normalizeIsbn10(isbn10));
}

export function searchCatalog(query: string) {
  const text = query.trim().toLowerCase();
  if (!text) return [];

  if (isIsbn10(query)) {
    const book = findEdition(query);
    return book ? [book] : [];
  }

  const words = text.split(/\s+/);

  return editions.filter(book => {
    const searchableText = [book.title, book.subtitle, ...book.authors, book.categories]
      .flat()
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return words.every(word => searchableText.includes(word));
  });
}

type IsbnLookupResult = {
  isbn10: string;
  source: "local" | "peers";
  foundAt: { branch: Lowercase<Branch>; book: Book }[];
  offline: Lowercase<Branch>[];
  warning?: string;
};

type ServerBook = Omit<Book, "authors"> & {
  authors?: string | string[];
  author?: string | string[];
};

type ServerLookupResult = Omit<IsbnLookupResult, "foundAt"> & {
  foundAt: { branch: Lowercase<Branch>; book: ServerBook }[];
};

export async function lookupIsbn(
  query: string,
  homeBranch: Branch = "Oshawa",
): Promise<IsbnLookupResult> {
  const isbn10 = normalizeIsbn10(query);

  if (!isIsbn10(isbn10)) {
    throw new Error("Enter a 10-character ISBN.");
  }

  const response = await fetch(
    `/catalog-api/${homeBranch.toLowerCase()}/api/circulation/books/${encodeURIComponent(isbn10)}`,
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Catalog lookup failed (HTTP ${response.status}).`);
  }

  const result: ServerLookupResult | null = await response.json();

  if (!result || !Array.isArray(result.foundAt)) {
    throw new Error("The server returned an unexpected catalog response.");
  }

  return {
    ...result,
    offline: result.offline ?? [],
    foundAt: result.foundAt.map(({ branch, book }) => ({
      branch,
      book: { ...book, authors: [book.authors ?? book.author ?? []].flat() },
    })),
  };
}