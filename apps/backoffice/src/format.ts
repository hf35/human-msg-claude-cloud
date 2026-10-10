import dayjs from 'dayjs';

/** Date and time as the team reads it: `10.10.2026 14:05`; a dash when there is none. */
export const formatTime = (iso: string | null | undefined): string =>
  iso ? dayjs(iso).format('DD.MM.YYYY HH:mm') : '—';
