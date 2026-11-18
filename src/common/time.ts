import { DEFAULT_TIMEZONE } from "../shared";

export function kolkataMonthRange(now = new Date()): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const start = new Date(Date.UTC(year, month - 1, 1, -5, -30, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, -5, -30, 0, 0));
  return { start, end };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
