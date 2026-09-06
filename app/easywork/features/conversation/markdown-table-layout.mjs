export function markdownTableLayout(rows) {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  if (!columns) return { widths: [], stackBelow: 0 };
  const units = (value) => [...String(value || "")].reduce((total, char) => total + (/[^\x00-\xff]/u.test(char) ? 2 : 1), 0);
  const weights = Array.from({ length: columns }, (_, column) => {
    const body = rows.slice(1).map((row) => Math.min(160, units(row[column])));
    const average = body.reduce((total, size) => total + size, 0) / Math.max(1, body.length);
    return Math.sqrt(Math.max(8, units(rows[0]?.[column]) * 2, average));
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const minimum = Math.min(16, 50 / columns);
  return {
    widths: weights.map((weight) => minimum + (100 - minimum * columns) * weight / total),
    stackBelow: columns > 2 ? columns * 104 : 0,
  };
}
