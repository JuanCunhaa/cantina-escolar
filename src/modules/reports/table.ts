import { csvCell } from "@/modules/orders/fulfillment-model";
import { microsToReaisText } from "@/modules/inventory/cost";
import { bpDecimal, brl } from "./format";

/**
 * Tabela neutra de exportação (F21): o MESMO conteúdo alimenta CSV e XLSX. Texto livre (nome de produto, motivo, operador) é `string`
 * e passa por neutralização de fórmula; números são gerados aqui (`NumCell`) a partir de inteiros e nunca vêm de usuário.
 */
export type NumCell = { kind: "num"; text: string; value: number };
export type Cell = string | NumCell;
export type Table = { name: string; header: readonly string[]; rows: readonly (readonly Cell[])[] };

const num = (text: string, value: number): NumCell => ({ kind: "num", text, value });

export const intCell = (n: number): NumCell => num(String(n), n);
/** Centavos → R$; `null` = desconhecido: célula VAZIA (nunca "0,00"). */
export const centsCell = (cents: number | null): Cell => (cents === null ? "" : num(brl(cents), cents / 100));
/** Micro-centavos → R$ com a precisão exata (até 8 casas); `null` = vazio. */
export const microsCell = (micros: number | null): Cell => (micros === null ? "" : num(microsToReaisText(micros), micros / 100_000_000));
/** Pontos-base → percentual com 2 casas (1234 → "12,34"). */
export const percentCell = (bp: number | null): Cell => (bp === null ? "" : num(bpDecimal(bp), bp / 100));

const encode = (c: Cell): string => (typeof c === "string" ? csvCell(c) : c.text);
const line = (cells: readonly Cell[]): string => cells.map(encode).join(";");

/** CSV pt-BR: separador `;`, CRLF, UTF-8 com BOM. */
export function tableCsv(table: Table): string {
  return `﻿${[line(table.header), ...table.rows.map(line)].join("\r\n")}\r\n`;
}
