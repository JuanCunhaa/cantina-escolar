import type { PaymentMethod } from "@/modules/payments/methods";
import type { TerminalOption } from "../fee-queries";

/**
 * Escolha opcional da maquininha usada no recebimento por cartão. Mostra só o nome (nunca percentuais ou prazos): a taxa estimada e a
 * previsão de liquidação são calculadas no servidor pela regra cadastrada pela administração. Sem escolha = fonte padrão.
 */
export function TerminalField({ id, terminals, method, value, disabled, onChange }: { id: string; terminals: readonly TerminalOption[]; method: PaymentMethod; value: string; disabled: boolean; onChange: (sourceId: string) => void }) {
  const options = terminals.filter((t) => (t.methods as string[]).includes(method));
  if (!method.startsWith("card") || options.length === 0) return null;
  return (
    <div className="field">
      <label htmlFor={id}>Maquininha usada (opcional)</label>
      <select id={id} value={options.some((o) => o.sourceId === value) ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={id}>
        <option value="">Não informada</option>
        {options.map((t) => (
          <option key={t.sourceId} value={t.sourceId}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}
