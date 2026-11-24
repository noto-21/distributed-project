// Simple frontend recommendation algorithm.
// It receives catalog books and My Books, then returns the top 4 suggestions.
export type CatalogBook = {
  isbn10: string;
  title: string;
  author?: string[];
  categories?: string;
  thumbnail?: string;
  average_rating?: number;
  ratings_count?: number;
  currentBranch?: string;
  status?: string;
};

export type MyBook = {
  isbn10?: string;
  title: string;
  author?: string | string[];
  genre?: string;
  categories?: string;
};

export type RecommendedBook = CatalogBook & { reason: string };

const clean = (text?: string) => (text ?? "").trim().toLowerCase();

// Ignore broad words so "Fantasy fiction" doesn't match "Classic fiction".
function similarGenre(first?: string, second?: string): boolean {
  if (!first || !second) return false;
  if (clean(first) === clean(second)) return true;

  const ignored = ["fiction", "nonfiction", "novel", "novels", "books", "and", "the"];
  const words = (genre: string) => clean(genre)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !ignored.includes(word));

  return words(first).some((word) => words(second).includes(word));
}

export function recommendBooks(
  catalog: CatalogBook[],
  myBooks: MyBook[],
  limit = 4
): RecommendedBook[] {
  // 1. Remove books already in My Books, and avoid duplicate titles.
  const unique = new Map<string, CatalogBook>();
  for (const book of catalog) {
    if (!book.title || !book.isbn10) continue;
    const alreadyOwned = myBooks.some((mine) =>
      (mine.isbn10 && clean(mine.isbn10) === clean(book.isbn10)) ||
      clean(mine.title) === clean(book.title)
    );
    if (alreadyOwned) continue;

    const key = clean(book.title);
    const previous = unique.get(key);
    // If two branches have the same title, prefer an available copy.
    if (!previous || (clean(book.status) === "available" && clean(previous.status) !== "available")) {
      unique.set(key, book);
    }
  }

  // 2. Compare each candidate to My Books and give it a score.
  const ranked = [...unique.values()].map((book) => {
    let matchPoints = 0;
    let reason = "Explore something different";

    for (const mine of myBooks) {
      const myAuthors = Array.isArray(mine.author)
        ? mine.author
        : mine.author ? [mine.author] : [];
      const sameAuthor = (book.author ?? []).some((author) =>
        myAuthors.some((myAuthor) => clean(author) === clean(myAuthor))
      );
      const sameGenre = similarGenre(book.categories, mine.genre ?? mine.categories);

      if (sameAuthor && matchPoints < 5) {
        matchPoints = 5;
        reason = `More by ${book.author?.[0] ?? "the same author"}`;
      } else if (sameGenre && matchPoints < 3) {
        matchPoints = 3;
        reason = `Similar genre to ${mine.title}`;
      }
    }

    // Rating adds at most 1 point; author/genre similarity matters more.
    const ratingBonus = Math.max(0, Math.min(5, book.average_rating ?? 0)) / 5;
    if (matchPoints === 0 && ratingBonus >= 0.8) {
      reason = "Highly rated in the catalog";
    }
    return { ...book, reason, score: matchPoints + ratingBonus };
  });

  // 3. Sort highest to lowest and return the top recommendations.
  ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return ranked.slice(0, Math.max(0, limit)).map(({ score, ...book }) => book);
}
