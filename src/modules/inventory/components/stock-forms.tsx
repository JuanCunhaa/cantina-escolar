"use client";

import { useRef, useState } from "react";
import type { User } from "firebase/auth";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { api, errorText, newKey } from "@/lib/api-client";
import { useUnits } from "@/modules/school/use-units";
import type { ProductStockView } from "../queries";
import { LOSS_REASON_LABEL, RECEIPT_KIND_LABEL } from "../format";

type Message = { kind: "ok" | "error"; text: string };

/** Mensagens específicas do estoque (a resposta traz códigos estáveis; `details` explica o que fazer). */
const STOCK_MESSAGES: Record<string, string> = {
  insufficient_stock: "Estoque insuficiente (unidades reservadas, vencidas ou inexistentes não podem ser baixadas).",
  entry_required: "Falta registrar a entrada física deste produto.",
  stale_count: "O estoque mudou depois do início da contagem. Recarregue e conte de novo.",
  cost_required: "Sem estoque para calcular o custo médio: informe o custo unitário.",
  invalid_cost: "Custo unitário inválido: use reais com até 4 casas decimais, maior que zero.",
  receipt_consumed: "Esta entrada já foi consumida. Use perda ou ajuste auditado em vez de estorno.",
  receipt_reversed: "Esta entrada já foi estornada.",
  reserved_units: "Há pedidos reservando estas unidades. Trate os pedidos antes do estorno.",
  available_on_required: "Informe a data de disponibilidade do produto planejado.",
  date_out_of_window: "Data fora do intervalo permitido.",
  invalid_expiry: "A validade não pode ser anterior a hoje nem à data de disponibilidade.",
  stale_capacity: "A cota foi alterada por outra pessoa. Recarregue.",
  capacity_not_set: "A administração ainda não definiu a cota para esta data e turno.",
  lot_insufficient: "O lote não tem esta quantidade.",
  lot_not_found: "Lote não encontrado ou já esgotado.",
  stock_limit: "Estoque acima do limite do sistema.",
};
const textOf = (code: string) => STOCK_MESSAGES[code] ?? errorText(code);

type Result = Record<string, unknown>;

/** Envia um comando de estoque. Chave de idempotência nova a cada envio, repetida só após falha de rede com o mesmo conteúdo. */
function useStockCommand(user: User, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const pending = useRef<{ json: string; key: string } | null>(null);
  async function run(url: string, body: Record<string, unknown>, success: (data: Result) => string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const json = JSON.stringify(body);
    const key = pending.current?.json === json ? pending.current.key : newKey();
    const result = await api<Result>(user, "POST", url, { ...body, key });
    setBusy(false);
    if (!result.ok) {
      pending.current = result.status === 0 ? { json, key } : null; // resposta perdida: repetir com a mesma chave não duplica
      const details = result.details;
      setMessage({ kind: "error", text: textOf(result.error) + (typeof details?.missingUnits === "number" ? ` Registre a entrada de ${details.missingUnits} unidade(s).` : "") });
      return false;
    }
    pending.current = null;
    setMessage({ kind: "ok", text: success(result.data) });
    onDone();
    return true;
  }
  return { busy, message, run };
}

function Notice({ message, testId }: { message: Message | null; testId: string }) {
  if (!message) return null;
  return (
    <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid={testId}>
      {message.text}
    </p>
  );
}

const compact = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== undefined && v !== null));
const toInt = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

/* ------------------------------------------------------------------------------------------------- entrada */

export function EntryForm({ user, view, onDone }: { user: User; view: ProductStockView; onDone: () => void }) {
  const cmd = useStockCommand(user, onDone);
  const today = localDateOf(new Date());
  const planned = view.mode === "planned";
  const [kind, setKind] = useState(planned ? "production" : "purchase");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [availableOn, setAvailableOn] = useState(planned ? today : "");
  const [expiresOn, setExpiresOn] = useState("");
  const [lotCode, setLotCode] = useState("");
  const [supplier, setSupplier] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [note, setNote] = useState("");
  const id = `entry-${view.productId}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = toInt(quantity);
    if (!Number.isSafeInteger(q) || q < 1) return;
    const ok = await cmd.run("/api/inventory/receipts", { action: "create", productId: view.productId, kind, quantity: q, unitCost: unitCost.replace(/\s/g, ""), ...compact({ availableOn, expiresOn, lotCode, supplier, documentRef, note }) }, () => "Entrada registrada.");
    if (ok) {
      setQuantity("");
      setUnitCost("");
      setExpiresOn("");
      setLotCode("");
      setDocumentRef("");
      setNote("");
    }
  }

  return (
    <form onSubmit={submit} className="form-grid" aria-label="Registrar entrada" data-testid="entry-form">
      <div className="field">
        <label htmlFor={`${id}-kind`}>Tipo</label>
        <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(RECEIPT_KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-qty`}>Quantidade (unidades)</label>
        <input id={`${id}-qty`} inputMode="numeric" pattern="[0-9]+" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-cost`}>Custo unitário (R$)</label>
        <input id={`${id}-cost`} inputMode="decimal" placeholder="1,10" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-avail`}>{planned ? "Disponível em (obrigatório)" : "Data do recebimento"}</label>
        <input id={`${id}-avail`} type="date" value={availableOn} max={planned ? addDays(today, 30) : today} min={planned ? today : undefined} onChange={(e) => setAvailableOn(e.target.value)} required={planned} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-exp`}>Validade (opcional)</label>
        <input id={`${id}-exp`} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-lot`}>Lote (opcional)</label>
        <input id={`${id}-lot`} value={lotCode} maxLength={40} onChange={(e) => setLotCode(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-sup`}>Fornecedor (opcional)</label>
        <input id={`${id}-sup`} value={supplier} maxLength={80} onChange={(e) => setSupplier(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-doc`}>Documento (opcional)</label>
        <input id={`${id}-doc`} value={documentRef} maxLength={60} onChange={(e) => setDocumentRef(e.target.value)} />
      </div>
      <div className="field field-wide">
        <label htmlFor={`${id}-note`}>Observação (opcional)</label>
        <input id={`${id}-note`} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="field">
        <button type="submit" disabled={cmd.busy}>
          Registrar entrada
        </button>
      </div>
      <div className="field-wide">
        <p className="muted">Cada compra é uma entrada separada: o custo médio é calculado sobre o que está em estoque. Para corrigir uma entrada errada, use Estornar na lista de entradas.</p>
        <Notice message={cmd.message} testId="entry-message" />
      </div>
    </form>
  );
}

/* --------------------------------------------------------------------------------------------------- perda */

export function LossForm({ user, view, onDone }: { user: User; view: ProductStockView; onDone: () => void }) {
  const cmd = useStockCommand(user, onDone);
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("expiry");
  const [note, setNote] = useState("");
  const [lotId, setLotId] = useState("");
  const [affected, setAffected] = useState<string[]>([]);
  const id = `loss-${view.productId}`;
  const lots = view.lots.filter((l) => l.remaining > 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setAffected([]);
    const q = toInt(quantity);
    if (!Number.isSafeInteger(q) || q < 1) return;
    const ok = await cmd.run("/api/inventory/losses", { productId: view.productId, quantity: q, reason, note: note.trim(), ...compact({ lotId }) }, (d) => {
      const short = Number(d.shortfallUnits ?? 0);
      const orders = ((d.affectedReservations as { orderRef: string; consumptionDate: string; remaining: number }[]) ?? []).map((r) => `Pedido ${r.orderRef} (${r.consumptionDate}, ${r.remaining} un.)`);
      setAffected(orders);
      return short > 0 ? `Perda registrada. Atenção: ${short} unidade(s) reservadas ficaram sem estoque. Trate os pedidos listados.` : "Perda registrada.";
    });
    if (ok) {
      setQuantity("");
      setNote("");
      setLotId("");
    }
  }

  return (
    <form onSubmit={submit} className="form-grid" aria-label="Registrar perda" data-testid="loss-form">
      <div className="field">
        <label htmlFor={`${id}-qty`}>Quantidade</label>
        <input id={`${id}-qty`} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-reason`}>Motivo</label>
        <select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)}>
          {Object.entries(LOSS_REASON_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-lot`}>Lote (opcional)</label>
        <select id={`${id}-lot`} value={lotId} onChange={(e) => setLotId(e.target.value)}>
          <option value="">O que vence primeiro</option>
          {lots.map((l) => (
            <option key={l.id} value={l.id}>
              {l.lotCode ?? l.id.slice(0, 12)} · {l.remaining} un.{l.expired ? " · vencido" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field field-wide">
        <label htmlFor={`${id}-note`}>Observação (obrigatória)</label>
        <input id={`${id}-note`} value={note} minLength={3} maxLength={140} onChange={(e) => setNote(e.target.value)} required />
      </div>
      <div className="field">
        <button type="submit" disabled={cmd.busy}>
          Registrar perda
        </button>
      </div>
      <div className="field-wide">
        <Notice message={cmd.message} testId="loss-message" />
        {affected.length > 0 && (
          <ul data-testid="loss-affected">
            {affected.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------ inventário e ajuste */

export function CountForm({ user, view, onDone }: { user: User; view: ProductStockView; onDone: () => void }) {
  const count = useStockCommand(user, onDone);
  const adjust = useStockCommand(user, onDone);
  const [counted, setCounted] = useState("");
  const [countReason, setCountReason] = useState("");
  const [delta, setDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const id = `count-${view.productId}`;

  async function submitCount(event: React.FormEvent) {
    event.preventDefault();
    const q = toInt(counted);
    if (!Number.isSafeInteger(q)) return;
    const ok = await count.run("/api/inventory/adjustments", { action: "count", productId: view.productId, countedQuantity: q, expectedSeq: view.movementSeq, reason: countReason.trim(), ...compact({ unitCost: unitCost.trim() }) }, (d) =>
      d.changed ? `Contagem registrada: diferença de ${Number(d.delta) > 0 ? "+" : ""}${String(d.delta)} unidade(s).` : "Contagem confere com o sistema.",
    );
    if (ok) {
      setCounted("");
      setCountReason("");
    }
  }
  async function submitAdjust(event: React.FormEvent) {
    event.preventDefault();
    const n = /^-?\d+$/.test(delta.trim()) ? Number(delta.trim()) : NaN;
    if (!Number.isSafeInteger(n) || n === 0) return;
    const ok = await adjust.run("/api/inventory/adjustments", { action: "adjust", productId: view.productId, delta: n, reason: adjustReason.trim(), ...compact({ unitCost: unitCost.trim() }) }, () => "Ajuste registrado.");
    if (ok) {
      setDelta("");
      setAdjustReason("");
    }
  }

  return (
    <div data-testid="count-forms">
      <form onSubmit={submitCount} className="form-grid" aria-label="Contagem física">
        <div className="field">
          <label htmlFor={`${id}-counted`}>Contagem física (unidades)</label>
          <input id={`${id}-counted`} inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor={`${id}-creason`}>Motivo</label>
          <input id={`${id}-creason`} value={countReason} minLength={3} maxLength={140} onChange={(e) => setCountReason(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor={`${id}-ccost`}>Custo unitário (só se não houver estoque)</label>
          <input id={`${id}-ccost`} inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        </div>
        <div className="field">
          <button type="submit" disabled={count.busy}>
            Registrar contagem
          </button>
        </div>
        <div className="field-wide">
          <p className="muted">A diferença vira um movimento novo, ao custo médio. Movimentos antigos nunca são alterados.</p>
          <Notice message={count.message} testId="count-message" />
        </div>
      </form>
      <form onSubmit={submitAdjust} className="form-grid" aria-label="Ajuste de divergência">
        <div className="field">
          <label htmlFor={`${id}-delta`}>Ajuste (+ ou − unidades)</label>
          <input id={`${id}-delta`} inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor={`${id}-areason`}>Motivo</label>
          <input id={`${id}-areason`} value={adjustReason} minLength={3} maxLength={140} onChange={(e) => setAdjustReason(e.target.value)} required />
        </div>
        <div className="field">
          <button type="submit" disabled={adjust.busy}>
            Registrar ajuste
          </button>
        </div>
        <div className="field-wide">
          <Notice message={adjust.message} testId="adjust-message" />
        </div>
      </form>
    </div>
  );
}

export function ThresholdForm({ user, view, onDone }: { user: User; view: ProductStockView; onDone: () => void }) {
  const cmd = useStockCommand(user, onDone);
  const [value, setValue] = useState(view.minStock === null ? "" : String(view.minStock));
  const id = `min-${view.productId}`;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = value.trim();
    const min = text === "" ? null : toInt(text);
    if (min !== null && !Number.isSafeInteger(min)) return;
    await cmd.run("/api/inventory/adjustments", { action: "threshold", productId: view.productId, minStock: min }, () => "Estoque mínimo salvo.");
  }
  return (
    <form onSubmit={submit} className="form-grid" aria-label="Estoque mínimo">
      <div className="field">
        <label htmlFor={id}>Estoque mínimo (alerta)</label>
        <input id={id} inputMode="numeric" placeholder="sem alerta" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <div className="field">
        <button type="submit" disabled={cmd.busy}>
          Salvar mínimo
        </button>
      </div>
      <div className="field-wide">
        <Notice message={cmd.message} testId="threshold-message" />
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------------------------------------------- cota */

export function CapacityForm({ user, productId, onDone }: { user: User; productId: string; onDone: () => void }) {
  const cmd = useStockCommand(user, onDone);
  const units = useUnits();
  const shifts = units.shifts.filter((s) => s.status === "active");
  const today = localDateOf(new Date());
  const [date, setDate] = useState(today);
  const [shiftId, setShiftId] = useState("");
  const [capacity, setCapacity] = useState("");
  const id = `cap-${productId}`;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = toInt(capacity);
    const shift = shiftId || shifts[0]?.id;
    if (!Number.isSafeInteger(q) || !shift) return;
    await cmd.run("/api/inventory/capacity", { productId, date, shiftId: shift, capacity: q }, () => "Cota salva. Vale para novas reservas; pedidos já feitos não foram alterados.");
  }
  return (
    <form onSubmit={submit} className="form-grid" aria-label="Definir cota" data-testid="capacity-form">
      <div className="field">
        <label htmlFor={`${id}-date`}>Data</label>
        <input id={`${id}-date`} type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-shift`}>Turno</label>
        <select id={`${id}-shift`} value={shiftId || shifts[0]?.id || ""} onChange={(e) => setShiftId(e.target.value)}>
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-qty`}>Cota (unidades)</label>
        <input id={`${id}-qty`} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} required />
      </div>
      <div className="field">
        <button type="submit" disabled={cmd.busy || shifts.length === 0}>
          Salvar cota
        </button>
      </div>
      <div className="field-wide">
        <Notice message={cmd.message} testId="capacity-message" />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------- controles por linha */

export function ReverseControl({ user, receiptId, onDone }: { user: User; receiptId: string; onDone: () => void }) {
  const cmd = useStockCommand(user, onDone);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await cmd.run("/api/inventory/receipts", { action: "reverse", receiptId, reason: reason.trim() }, () => "Entrada estornada.");
    if (ok) setOpen(false);
  }
  if (!open) {
    return (
      <>
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Estornar
        </button>
        <Notice message={cmd.message} testId="reverse-message" />
      </>
    );
  }
  return (
    <form onSubmit={submit} className="limit-form" aria-label="Estornar entrada">
      <label htmlFor={`rev-${receiptId}`} className="sr-only">
        Motivo do estorno
      </label>
      <input id={`rev-${receiptId}`} placeholder="Motivo do estorno" value={reason} minLength={3} maxLength={140} onChange={(e) => setReason(e.target.value)} required />
      <button type="submit" disabled={cmd.busy}>
        Confirmar
      </button>
      <button type="button" className="secondary" onClick={() => setOpen(false)}>
        Cancelar
      </button>
      <Notice message={cmd.message} testId="reverse-message" />
    </form>
  );
}

export function ExtendControl({ user, productId, lotId, onDone }: { user: User; productId: string; lotId: string; onDone: () => void }) {
  const cmd = useStockCommand(user, onDone);
  const [open, setOpen] = useState(false);
  const today = localDateOf(new Date());
  const [until, setUntil] = useState(addDays(today, 1));
  const [reason, setReason] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await cmd.run("/api/inventory/adjustments", { action: "extend", productId, lotId, validThrough: until, reason: reason.trim() }, () => "Validade ampliada (sobra liberada de forma explícita).");
    if (ok) setOpen(false);
  }
  if (!open) {
    return (
      <>
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Ampliar validade
        </button>
        <Notice message={cmd.message} testId="extend-message" />
      </>
    );
  }
  return (
    <form onSubmit={submit} className="limit-form" aria-label="Ampliar validade da sobra">
      <label htmlFor={`ext-${lotId}`} className="sr-only">
        Nova validade
      </label>
      <input id={`ext-${lotId}`} type="date" min={addDays(today, 1)} max={addDays(today, 30)} value={until} onChange={(e) => setUntil(e.target.value)} required />
      <label htmlFor={`extr-${lotId}`} className="sr-only">
        Motivo
      </label>
      <input id={`extr-${lotId}`} placeholder="Motivo" value={reason} minLength={3} maxLength={140} onChange={(e) => setReason(e.target.value)} required />
      <button type="submit" disabled={cmd.busy}>
        Confirmar
      </button>
      <button type="button" className="secondary" onClick={() => setOpen(false)}>
        Cancelar
      </button>
      <Notice message={cmd.message} testId="extend-message" />
    </form>
  );
}
