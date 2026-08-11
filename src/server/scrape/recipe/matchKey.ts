// The key a BoardReader row is stored under: origin + first path segment,
// lowercased, no trailing slash.
//
// The grain matters. Origin alone is too coarse — one host fronts several
// boards (`jobs.example.com/eng`, `/sales`), and one recipe wouldn't read both.
// The full sourceUrl is too fine — query strings and trailing slashes vary per
// company, so the same board would mint a row each time and nobody would ever
// share one. The first path segment is where a multi-tenant board's tenant
// lives, which is exactly the line we want.
//
// Sharing is the point: two companies on the same board software resolve to the
// same key, so the second pays neither a probe nor a recon.

export function boardMatchKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const firstSegment = u.pathname.split("/").filter(Boolean)[0];
  const origin = u.origin.toLowerCase();
  return firstSegment ? `${origin}/${firstSegment.toLowerCase()}` : origin;
}
