export type CsvTable = {
  headers: string[];
  rows: string[][];
};

const stripBom = (value: string) => value.replace(/^\uFEFF/, '');

export const normalizeHeader = (value: string) => stripBom(value).trim();

export const parseCsv = (text: string): CsvTable => {
  const cleaned = stripBom(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let insideQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };

  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];

    if (insideQuotes) {
      if (char === '"') {
        if (cleaned[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
      continue;
    }

    if (char === ',') {
      pushCell();
      continue;
    }

    if (char === '\n') {
      pushCell();
      rows.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0 || cleaned.endsWith(',')) {
    pushCell();
    rows.push(row);
  }

  const filteredRows = rows.filter((currentRow) =>
    currentRow.some((value) => value.trim().length > 0)
  );
  const [headers = [], ...dataRows] = filteredRows;

  return {
    headers: headers.map(normalizeHeader),
    rows: dataRows
  };
};

const escapeCsvValue = (value: unknown) => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
};

export const stringifyCsv = (headers: string[], rows: unknown[][]) => {
  const lines = [headers.map(escapeCsvValue).join(',')];

  for (const row of rows) {
    lines.push(row.map(escapeCsvValue).join(','));
  }

  return `${lines.join('\n')}\n`;
};

export const stringifyCsvObjects = (
  headers: string[],
  rows: Array<Record<string, unknown>>
) =>
  stringifyCsv(
    headers,
    rows.map((row) => headers.map((header) => row[header] ?? ''))
  );

export const parseNumberMaybe = (value: string | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

export const safeTrim = (value: string | null | undefined) =>
  value && value.trim().length > 0 ? value.trim() : null;

export const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

