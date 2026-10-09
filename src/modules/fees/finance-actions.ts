import { errorText, type ApiResult } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { differenceText } from "@/modules/cash/components/cash-text";

/**
 * Ações das telas financeiras como funções PURAS (sem React): recebem o `submit` (chave de idempotência por tentativa) e devolvem a
 * mensagem para a tela. Resultado só pela RESPOSTA do servidor; `null` = envio ignorado (clique duplo) ou resposta perdida (a tela
 * mostra o aviso de repetição, e a repetição reaproveita a mesma chave). Testáveis sem navegador.
 */
export type Message = { kind: "ok" | "error"; text: string };
export type Submit = <T>(url: string, body: Record<string, unknown>) => Promise<ApiResult<T> | null>;

/** Falha definitiva do servidor (4xx) = mensagem; rede/5xx/timeout = sem mensagem (a repetição confirma). */
const definitive = (r: { status: number }): boolean => r.status !== 0 && r.status < 500;

export const FEE_ERRORS: Record<string, string> = {
  source_exists: "Já existe um cadastro com este código.",
  source_not_found: "Cadastro não encontrado.",
  source_inactive: "Cadastro arquivado: reative-o antes de publicar regra.",
  method_not_in_source: "O cadastro não aceita este meio.",
  fictitious_mismatch: "Regra e cadastro precisam ser ambos fictícios ou ambos reais.",
  fictitious_in_production: "Dados fictícios não são aceitos em produção.",
  effective_in_past: "A vigência não pode ser anterior a hoje: regras não são retroativas.",
  effective_not_after_last: "A vigência precisa ser posterior à da última versão.",
  too_many_versions: "Limite de versões desta regra atingido.",
  version_in_effect: "A versão já está em vigor: publique uma nova em vez de retirá-la.",
  already_withdrawn: "Versão já retirada.",
  version_not_found: "Versão não encontrada.",
  source_reserved: "A fonte padrão não pode ser arquivada.",
};

export const RECONCILE_ERRORS: Record<string, string> = {
  stale_receipt: "Este recebimento foi conferido por outra operação. A lista foi atualizada: confira os valores atuais.",
  correction_requires_reason: "Corrigir um valor já conferido exige motivo.",
  nothing_to_change: "Nada mudou em relação ao que já está registrado.",
  invalid_fee: "A taxa precisa estar entre zero e o valor recebido.",
  invalid_settlement_date: "A liquidação real fica entre a data do recebimento e hoje.",
  not_applicable: "Dinheiro não tem taxa nem liquidação bancária a conferir.",
  receipt_not_found: "Recebimento não encontrado.",
};

export const SESSION_ERRORS: Record<string, string> = {
  not_closed: "O caixa não está fechado (foi reaberto ou ainda está aberto). A tela foi atualizada.",
  stale_closure: "Existe um fechamento mais novo: a tela foi atualizada.",
  no_divergence: "Este fechamento não tem divergência a revisar.",
  session_not_found: "Caixa não encontrado.",
};

/** Comando simples da administração: mensagem de sucesso ou o texto do erro (mapa próprio, depois o geral). */
export async function adminAction(submit: Submit, url: string, body: Record<string, unknown>, okText: string, errors: Record<string, string> = {}): Promise<Message | null> {
  const r = await submit(url, body);
  if (!r) return null;
  return r.ok ? { kind: "ok", text: okText } : { kind: "error", text: errors[r.error] ?? errorText(r.error) };
}

/* ------------------------------------------------------------------------------------- caixa do operador */

export type CloseDraft = { countedCashCents: number; declared: { pixCents?: number; cardDebitCents?: number; cardCreditCents?: number }; note: string; expectedReceiptCount: number; expectedNetCents: number };

export async function openCashAction(submit: Submit, input: { point: string; date: string; openingCents: number }): Promise<Message | null> {
  const r = await submit<{ sessionId: string }>("/api/cash/open", { point: input.point, date: input.date, openingCents: input.openingCents, openingConfirmed: true });
  if (!r) return null;
  if (r.ok) return { kind: "ok", text: `Caixa aberto com saldo inicial de ${formatBRL(input.openingCents)}.` };
  if (r.error === "session_exists") return { kind: "error", text: "Este caixa já foi aberto. A tela foi atualizada." };
  if (r.error === "invalid_date") return { kind: "error", text: "Só é possível abrir o caixa de hoje até 7 dias para trás." };
  return definitive(r) ? { kind: "error", text: errorText(r.error) } : null;
}

export async function closeCashAction(submit: Submit, sessionId: string, draft: CloseDraft): Promise<Message | null> {
  const r = await submit<{ hasDivergence: boolean; cashDifferenceCents: number; closureNo: number }>("/api/cash/close", {
    sessionId,
    countedCashCents: draft.countedCashCents,
    declared: draft.declared,
    ...(draft.note ? { note: draft.note } : {}),
    expectedReceiptCount: draft.expectedReceiptCount,
    expectedNetCents: draft.expectedNetCents,
  });
  if (!r) return null;
  if (r.ok) {
    return r.data.hasDivergence
      ? { kind: "error", text: `Caixa fechado com divergência (${differenceText(r.data.cashDifferenceCents)}). Ela fica pendente de revisão da administração.` }
      : { kind: "ok", text: "Caixa fechado sem diferença." };
  }
  if (r.error === "stale_summary") return { kind: "error", text: "Entraram novos recebimentos ou estornos desde que você viu o resumo. Confira de novo antes de fechar." };
  if (r.error === "already_closed") return { kind: "error", text: "Este caixa já está fechado. A tela foi atualizada." };
  return definitive(r) ? { kind: "error", text: errorText(r.error) } : null;
}

/* ----------------------------------------------------------------------------------------- exportação */

export type ExportDeps = {
  token: () => Promise<string>;
  fetchFn: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; json: () => Promise<unknown>; blob: () => Promise<Blob> }>;
  save: (blob: Blob, filename: string) => void;
};

/** Baixa o CSV mensal; devolve a mensagem de erro (ou `null` quando o arquivo foi salvo). */
export async function exportAction(deps: ExportDeps, month: string, view: "detail" | "summary"): Promise<string | null> {
  try {
    const response = await deps.fetchFn(`/api/admin/finance/export?month=${month}&view=${view}`, { headers: { authorization: `Bearer ${await deps.token()}` } });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string } | null | undefined;
      return body?.error === "export_truncated" ? "Há recebimentos demais no mês para uma exportação completa." : errorText(body?.error ?? "internal");
    }
    deps.save(await response.blob(), `financeiro-${view === "detail" ? "detalhe" : "resumo"}-${month}.csv`);
    return null;
  } catch {
    return errorText("network");
  }
}
