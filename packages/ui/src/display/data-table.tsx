import type { ReactNode } from 'react';

export interface DataColumn<Row> {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  numeric?: boolean;
}

export function DataTable<Row>({
  caption,
  columns,
  getRowKey,
  rows,
}: {
  caption: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data tables must be keyboard-focusable.
    <section className="ot-table-region" aria-label={caption} tabIndex={0}>
      <table className="ot-table">
        <caption className="ot-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td className={column.numeric ? 'ot-money' : undefined} key={column.id}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
