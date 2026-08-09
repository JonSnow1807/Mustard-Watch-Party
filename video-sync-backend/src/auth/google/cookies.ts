/**
 * Reading one cookie by name. Express only populates `req.cookies` when
 * cookie-parser is installed as middleware, and one route needing one
 * cookie is not worth a global dependency that every other request then
 * pays for - so we read the header we were sent.
 */
export const readCookie = (
  header: string | undefined,
  name: string,
): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // a value that is not valid percent-encoding cannot be ours
      return undefined;
    }
  }
  return undefined;
};
