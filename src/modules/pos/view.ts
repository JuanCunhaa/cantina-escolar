import { normalizeName } from "@/modules/students/normalize";
import type { PosProduct, PosStudent, PosStudentRow } from "./queries";

/**
 * Regras puras da tela do PDV (busca, atalhos, pré-checagens). A decisão final é SEMPRE do servidor na confirmação; aqui só
 * se evita enviar o que já se sabe recusado e se explica ao operador o porquê (saldo, bloqueio, teto do dia).
 */
export const MAX_SHOWN_STUDENTS = 30;

export type CartLine = { productId: string; quantity: number };

/** Todos os termos (sem acento, qualquer ordem) dentro do nome, ou trecho da matrícula. Vazio = ninguém (lista só ao digitar). */
export function searchStudents(rows: readonly PosStudentRow[], query: string): PosStudentRow[] {
  const terms = normalizeName(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const matches = rows.filter((row) => {
    const name = normalizeName(row.name);
    const enrollment = row.enrollment.toLowerCase();
    return terms.every((t) => name.includes(t) || enrollment.includes(t));
  });
  // Nome que COMEÇA pelo que foi digitado vem primeiro; empate pela ordem alfabética já vinda do servidor.
  const head = normalizeName(query);
  return [...matches].sort((a, b) => Number(normalizeName(b.name).startsWith(head)) - Number(normalizeName(a.name).startsWith(head)));
}

/** IDs de alunos que dividem o mesmo nome (sem acento/caixa): a tela os destaca para conferir turma e turno. */
export function homonymIds(rows: readonly PosStudentRow[]): Set<string> {
  const byName = new Map<string, string[]>();
  for (const row of rows) byName.set(normalizeName(row.name), [...(byName.get(normalizeName(row.name)) ?? []), row.id]);
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}

/** "10 bala" → { quantity: 10, term: "bala" }; sem número = 1. Teto 99 para evitar digitação acidental enorme. */
export function parseQuickAdd(text: string): { quantity: number; term: string } {
  const match = /^\s*(\d{1,2})\s*[x×*]?\s+(.+)$/i.exec(text);
  if (!match) return { quantity: 1, term: text.trim() };
  return { quantity: Math.max(1, Number(match[1])), term: match[2]!.trim() };
}

export function filterProducts(products: readonly PosProduct[], term: string, categoryId: string): PosProduct[] {
  const needle = normalizeName(term);
  return products.filter((p) => (!categoryId || p.categoryId === categoryId) && (!needle || normalizeName(p.name).includes(needle)));
}

export function totalOf(cart: readonly CartLine[], products: readonly PosProduct[]): number {
  const price = new Map(products.map((p) => [p.id, p.priceCents]));
  return cart.reduce((sum, l) => sum + (price.get(l.productId) ?? 0) * l.quantity, 0);
}

export type Precheck = {
  totalCents: number;
  /** Produtos do carrinho bloqueados para o aluno (produto ou categoria). */
  blocked: string[];
  overBalanceCents: number;
  /** Quanto o carrinho passa do que ainda cabe hoje (teto diário/semanal), ou 0. */
  overLimitCents: number;
  overStock: string[];
};

/** Avisos antes de confirmar. `student` nulo = venda direta (sem saldo nem política). */
export function precheck(cart: readonly CartLine[], products: readonly PosProduct[], student: PosStudent | null): Precheck {
  const byId = new Map(products.map((p) => [p.id, p]));
  const totalCents = totalOf(cart, products);
  const blocked: string[] = [];
  const overStock: string[] = [];
  for (const line of cart) {
    const p = byId.get(line.productId);
    if (!p) continue;
    if (student && (student.restrictions.blockedProductIds.includes(p.id) || student.restrictions.blockedCategoryIds.includes(p.categoryId))) blocked.push(p.name);
    if (line.quantity > p.availableUnits) overStock.push(p.name);
  }
  const remaining = student?.restrictions.remainingTodayCents ?? null;
  return {
    totalCents,
    blocked,
    overBalanceCents: student ? Math.max(0, totalCents - student.wallet.balanceCents) : 0,
    overLimitCents: remaining === null ? 0 : Math.max(0, totalCents - remaining),
    overStock,
  };
}

/** Contagem de vendas por produto neste dispositivo (atalhos "frequentes"); nunca sai do navegador. */
const FREQUENT_STORAGE = "pos.frequent.v1";
export function readFrequent(): Record<string, number> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FREQUENT_STORAGE) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number" && Number.isFinite(v)) as [string, number][]);
  } catch {
    return {};
  }
}
export function bumpFrequent(productIds: readonly string[]): void {
  try {
    const counts = readFrequent();
    for (const id of productIds) counts[id] = (counts[id] ?? 0) + 1;
    window.localStorage.setItem(FREQUENT_STORAGE, JSON.stringify(counts));
  } catch {
    /* armazenamento indisponível (janela privada): os atalhos só deixam de aprender */
  }
}
export function frequentProducts(products: readonly PosProduct[], counts: Record<string, number>, max = 6): PosProduct[] {
  return products
    .filter((p) => (counts[p.id] ?? 0) > 0)
    .sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, max);
}

/** Turno padrão da venda direta pelo horário: antes das 12h manhã, depois tarde; sem identificação, o primeiro. */
export function defaultShiftId(shifts: readonly { id: string; slug: string }[], now: Date = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(now));
  const slug = hour < 12 ? "manha" : "tarde";
  return (shifts.find((s) => s.slug === slug) ?? shifts[0])?.id ?? "";
}
