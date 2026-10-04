import type { User } from "firebase/auth";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; details?: Record<string, unknown> };

/** Chamada autenticada à API do servidor (ID token atual). Nunca lança: devolve o código de erro estável. */
export async function api<T = Record<string, unknown>>(
  user: User | null,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers.authorization = `Bearer ${await user.getIdToken()}`;
    const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const response = await fetch(url, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string; details?: Record<string, unknown> };
    return response.ok ? { ok: true, data } : { ok: false, status: response.status, error: data.error ?? "internal", details: data.details };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

/** Chave de idempotência por tentativa de formulário (reutilizada em reenvio do mesmo envio). */
export const newKey = (): string => crypto.randomUUID();

const MESSAGES: Record<string, string> = {
  network: "Sem conexão com o servidor. Tente novamente.",
  unauthenticated: "Sua sessão expirou. Entre novamente.",
  account_inactive: "Esta conta está desativada.",
  forbidden: "Seu perfil não tem permissão para esta ação.",
  invalid_input: "Confira os campos preenchidos.",
  idempotency_conflict: "Esta operação já foi enviada com dados diferentes. Recarregue a página.",
  already_exists: "Já existe um cadastro igual.",
  name_taken: "Já existe outra turma/turno com este nome.",
  unit_in_use: "Há alunos ativos nesta turma/turno. Mude os alunos antes de arquivar.",
  unit_not_found: "Turma/turno não encontrado.",
  enrollment_taken: "Esta matrícula já está cadastrada.",
  class_unavailable: "Turma inexistente ou arquivada.",
  shift_unavailable: "Turno inexistente ou arquivado.",
  student_not_found: "Aluno não encontrado.",
  student_inactive: "O aluno está inativo.",
  student_has_balance: "Este aluno tem saldo na carteira. Transfira ou resolva o saldo antes de arquivar o cadastro.",
  guardian_not_found: "Nenhuma conta encontrada com este e-mail.",
  not_a_guardian: "Esta conta não é de um responsável ativo.",
  link_not_found: "Vínculo não encontrado.",
  too_many_invitations: "Já existem convites pendentes demais para este aluno. Revogue algum.",
  student_has_login: "O aluno já possui login.",
  account_already_student: "Esta conta já é login de outro aluno.",
  invitation_invalid: "Convite inválido, expirado ou já utilizado. Peça um novo à escola.",
  account_exists: "Já existe uma conta com este e-mail. Entre com ela e abra o convite novamente.",
  account_role_mismatch: "Esta conta tem outro perfil de acesso e não pode usar este convite.",
  account_data_required: "Informe nome, e-mail e senha.",
  stale_preview: "Os dados mudaram desde a prévia. Gere a prévia novamente.",
  rows_with_errors: "Corrija ou remova as linhas com erro antes de confirmar.",
  warnings_not_accepted: "Há avisos de possível duplicidade. Marque a confirmação para continuar.",
  no_changes: "Nenhuma alteração informada.",
  stale_policy: "Outra pessoa alterou os limites ou bloqueios agora. A tela foi atualizada; revise e tente de novo.",
  daily_exceeds_weekly: "O limite diário não pode ser maior que o semanal.",
  blocked_item_not_found: "Produto ou categoria não encontrado.",
  exception_not_found: "Autorização não encontrada.",
  exception_used: "Esta autorização já foi usada.",
  admin_reason_required: "Informe o motivo da exceção administrativa (mínimo 10 caracteres).",
  date_out_of_window: "Escolha uma data de hoje até daqui a 7 dias.",
  exception_scope_required: "Informe a data e o valor máximo.",
  file_too_large: "Arquivo grande demais (máximo 256 KB).",
  too_many_rows: "Arquivo com linhas demais (máximo 500).",
  empty_file: "O arquivo está vazio.",
  missing_columns: "O arquivo precisa das colunas matrícula, nome, turma e turno.",
  unterminated_quote: "Aspas sem fechamento no arquivo.",
  invalid_name: "O nome precisa ter letras ou números.",
  category_name_taken: "Já existe uma categoria com este nome.",
  category_in_use: "Há produtos ativos nesta categoria. Mude ou desative os produtos antes de arquivar.",
  category_not_found: "Categoria não encontrada.",
  category_unavailable: "Categoria inexistente ou arquivada.",
  product_name_taken: "Já existe um produto com este nome (talvez desativado). Reative-o em vez de criar outro.",
  product_not_found: "Produto não encontrado.",
  stale_product: "O produto foi alterado por outra pessoa. Abra novamente para ver a versão atual.",
  stale_price: "O preço foi alterado por outra pessoa. Confira o preço atual antes de salvar.",
  stale_menu: "O cardápio foi alterado por outra pessoa. A tela já mostra a versão atual: revise e tente de novo.",
  already_in_default: "Este produto já está no cardápio padrão deste turno.",
  not_in_default: "O produto não faz parte do cardápio padrão deste turno.",
  shift_not_allowed: "O produto não é vendido neste turno (ajuste os turnos no cadastro do produto).",
  product_inactive: "Produto desativado.",
  past_date: "Não é possível alterar uma data passada.",
  too_far: "Data distante demais.",
  too_many_items: "Exceções demais nesta data e turno.",
  shift_not_configured: "Os horários do turno deste aluno ainda não foram configurados pela escola.",
  student_required: "Selecione o aluno.",
  beyond_window: "Compras só de hoje até 7 dias à frente.",
  insufficient_balance: "Saldo insuficiente na carteira do aluno.",
  balance_limit: "A carteira de destino atingiria o limite de saldo.",
  mode_in_use: "O produto tem estoque ou reservas ativas: zere o estoque e trate as reservas antes de mudar o modo (físico/planejado).",
  insufficient_stock: "Estoque insuficiente (unidades reservadas, vencidas ou inexistentes não podem ser baixadas).",
  capacity_exceeded: "A cota desta data e turno está esgotada.",
  price_changed: "Os preços mudaram. Revise o novo total e confirme de novo.",
  confirmation_required: "Esta compra supera limites ou bloqueios definidos para o aluno. Confirme explicitamente para continuar.",
  policy_denied: "Esta compra não é permitida pelos limites ou bloqueios definidos para o aluno.",
  shift_changed: "O turno do aluno mudou. Atualize a página e revise o carrinho.",
  item_unavailable: "Um dos produtos não está mais disponível nesta data. Atualize o cardápio e revise o carrinho.",
  after_cutoff: "O horário limite de compra para uma das datas já passou.",
  non_operating_day: "Não há atendimento em uma das datas escolhidas.",
  invalid_date: "Data inválida.",
  internal: "Não foi possível concluir agora. Tente novamente.",
};

export const errorText = (code: string): string => MESSAGES[code] ?? MESSAGES.internal!;
