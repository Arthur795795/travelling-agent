/** Decode exactly one URL path segment at the server boundary. */
export function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
