const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

export const isDateString = (value: string | null | undefined): value is string =>
  Boolean(value && DATE_RE.test(value));

export const pad2 = (value: number) => String(value).padStart(2, '0');

export const getBeijingDateInput = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${value.year}-${value.month}-${value.day}`;
};

export const toDateInputValue = (date: Date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

export const parseDateInput = (value: string) => {
  if (!isDateString(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
};

export const clampDateInput = (value: string | null | undefined, fallback = getBeijingDateInput()) =>
  isDateString(value) ? value : fallback;

export const shiftDateInput = (dateInput: string, days: number) => {
  const date = parseDateInput(dateInput) ?? parseDateInput(getBeijingDateInput()) ?? new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return toDateInputValue(date);
};

export const formatDateLabel = (value: string) => {
  const date = parseDateInput(value);

  if (!date) {
    return value;
  }

  return date.toLocaleDateString('zh-CN', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });
};

export const startOfDay = (value: Date) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

export const addDaysToDate = (value: Date, days: number) => {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
};

export const eachDayOfRange = (startDate: Date, endDate: Date) => {
  const days: Date[] = [];
  const current = startOfDay(startDate);
  const end = startOfDay(endDate);

  while (current <= end) {
    days.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return days;
};

export const monthStart = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

export const monthEnd = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));

export const addMonths = (date: Date, months: number) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));

export const dateInputDiffInDays = (left: string, right: string) => {
  const leftDate = parseDateInput(left);
  const rightDate = parseDateInput(right);

  if (!leftDate || !rightDate) {
    return 0;
  }

  return Math.round((leftDate.getTime() - rightDate.getTime()) / 86_400_000);
};
