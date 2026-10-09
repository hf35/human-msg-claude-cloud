/** A date and time for the screen, in the user's language ("9 окт., 14:05" / "Oct 9, 2:05 PM"). */
export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}
