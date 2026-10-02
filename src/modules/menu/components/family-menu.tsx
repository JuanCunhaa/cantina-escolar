"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { ProductPhoto } from "@/components/ui/product-photo";
import { errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import type { Role } from "@/modules/access/roles";
import { useFamilyStudents } from "@/modules/guardians/use-family-students";
import { clockLabel, dayMonth, longDayLabel, weekdayLabel } from "../format";
import type { MenuDay, MenuProduct, MenuWeek } from "../model";
import { useMenuWeek } from "../use-menu";

/**
 * Portal: cardápio por data e turno do aluno, resolvido no servidor (padrão + extras − ocultos; suspensão e calendário).
 * A quantidade é só uma prévia: preço, horário e disponibilidade finais são revalidados no checkout (etapa futura).
 */
export function FamilyMenu({ user, role }: { user: User; role: Role }) {
  return role === "guardian" ? <GuardianMenu user={user} /> : <StudentMenu user={user} studentId={null} />;
}

function GuardianMenu({ user }: { user: User }) {
  const family = useFamilyStudents(user.uid);
  const [chosen, setChosen] = useState("");
  const students = family.students;
  const studentId = students.some((s) => s.id === chosen) ? chosen : (students[0]?.id ?? null);

  if (family.status === "loading") return <Intro status={<p role="status">Carregando os alunos…</p>} />;
  if (family.status === "error")
    return (
      <Intro
        status={
          <p role="alert" className="notice notice-error">
            Não foi possível carregar os alunos vinculados.
          </p>
        }
      />
    );
  if (!studentId) return <Intro status={<p>Nenhum aluno vinculado a esta conta. Peça à escola o convite de vínculo.</p>} />;

  const selector =
    students.length > 1 ? (
      <div className="field">
        <label htmlFor="menu-student">Aluno</label>
        <select id="menu-student" value={studentId} onChange={(event) => setChosen(event.target.value)}>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    ) : null;
  return <StudentMenu key={studentId} user={user} studentId={studentId} selector={selector} />;
}

function Intro({ status }: { status: ReactNode }) {
  return (
    <section>
      <h1>Cardápio</h1>
      {status}
    </section>
  );
}

/** Estado curto de cada data na faixa (a explicação completa aparece abaixo dela). */
const STATE_LABEL: Record<string, string> = {
  after_cutoff: "Encerrado",
  non_operating_day: "Fechado",
  service_suspended: "Suspenso",
};

function dayState(day: MenuDay): string {
  if (day.allowed) return "Aberto";
  return STATE_LABEL[day.reason ?? ""] ?? "Indisponível";
}

function DayNotice({ day, week }: { day: MenuDay; week: MenuWeek }) {
  const isToday = day.date === week.today;
  if (day.allowed && day.purchaseCutoffAt && day.cancelCutoffAt) {
    const sameDay = (instant: string) => (isToday ? `hoje às ${clockLabel(instant)}` : `${dayMonth(day.date)} às ${clockLabel(instant)}`);
    return (
      <p className="muted" data-testid="day-notice">
        Compras antecipadas até {sameDay(day.purchaseCutoffAt)}; cancelamento pela família até {sameDay(day.cancelCutoffAt)} (horário de Brasília).
      </p>
    );
  }
  const text =
    day.reason === "after_cutoff"
      ? `As compras antecipadas para hoje encerraram às ${week.cutoffs.purchaseCutoff}. No balcão, a venda segue conforme a disponibilidade.`
      : day.reason === "non_operating_day"
        ? "Sem atendimento nesta data (dia sem funcionamento)."
        : day.reason === "service_suspended"
          ? "Atendimento suspenso neste turno nesta data."
          : "Data indisponível para compra.";
  return (
    <p className="notice" data-testid="day-notice">
      {text}
    </p>
  );
}

function groupItems(day: MenuDay, products: Map<string, MenuProduct>): [string, { item: MenuDay["items"][number]; product: MenuProduct }[]][] {
  const groups = new Map<string, { item: MenuDay["items"][number]; product: MenuProduct }[]>();
  for (const item of day.items) {
    const product = products.get(item.productId);
    if (!product) continue;
    const name = product.categoryName || "Outros";
    groups.set(name, [...(groups.get(name) ?? []), { item, product }]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
}

function StudentMenu({ user, studentId, selector = null }: { user: User; studentId: string | null; selector?: ReactNode }) {
  const state = useMenuWeek(user, studentId);
  const week = state.week;
  const [picked, setPicked] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<{ date: string; values: Record<string, number> }>({ date: "", values: {} });
  const products = useMemo(() => new Map((week?.products ?? []).map((p) => [p.id, p])), [week]);

  const days = week?.days ?? [];
  const fallback = days.find((d) => d.allowed)?.date ?? days[0]?.date ?? null;
  const date = picked && days.some((d) => d.date === picked) ? picked : fallback;
  const day = days.find((d) => d.date === date) ?? null;
  const values = quantities.date === date ? quantities.values : {};
  const buyable = Boolean(day?.allowed && week?.canPurchase);

  const change = (id: string, delta: number) =>
    setQuantities((current) => {
      const base = current.date === date ? current.values : {};
      return { date: date ?? "", values: { ...base, [id]: Math.max(0, Math.min(20, (base[id] ?? 0) + delta)) } };
    });
  const selected = buyable ? (day?.items ?? []).filter((i) => (values[i.productId] ?? 0) > 0 && products.get(i.productId)?.channels.includes("advance")) : [];
  const totalCents = selected.reduce((sum, i) => sum + (products.get(i.productId)?.priceCents ?? 0) * (values[i.productId] ?? 0), 0);
  const itemCount = selected.reduce((sum, i) => sum + (values[i.productId] ?? 0), 0);

  return (
    <div className="menu-layout">
      <div>
        <h1>Cardápio</h1>
        {selector}
        {state.status === "loading" && <p role="status">Carregando o cardápio…</p>}
        {state.error && (
          <div role="alert" className="notice notice-error">
            <p>{week ? "Não foi possível atualizar o cardápio; exibindo a última versão carregada." : errorText(state.error)}</p>
            <button type="button" className="secondary" onClick={state.reload}>
              Tentar novamente
            </button>
          </div>
        )}
        {week && (
          <>
            <p className="menu-student" data-testid="menu-student">
              <strong>{week.student.name}</strong> <span className="muted">· Turno {week.student.shiftName}</span>
            </p>
            {!week.student.active && <p className="notice notice-error">Aluno inativo: compras bloqueadas.</p>}
            {week.student.active && !week.canPurchase && <p className="muted">Compra pelo site não liberada para este aluno: o cardápio fica disponível para consulta.</p>}

            <fieldset className="day-strip">
              <legend>Data do lanche</legend>
              {days.map((d) => (
                <label key={d.date} className="day-option" data-selected={d.date === date} data-open={d.allowed}>
                  <input
                    type="radio"
                    name="menu-date"
                    value={d.date}
                    checked={d.date === date}
                    onChange={() => setPicked(d.date)}
                    aria-label={`${d.date === week.today ? `Hoje, ${dayMonth(d.date)}` : longDayLabel(d.date)}: ${dayState(d)}`}
                  />
                  <span className="day-name">{d.date === week.today ? "Hoje" : weekdayLabel(d.date)}</span>
                  <span className="day-date">{dayMonth(d.date)}</span>
                  <span className="day-state">{dayState(d)}</span>
                </label>
              ))}
            </fieldset>

            {day && (
              <section aria-labelledby="menu-day-title" className="menu-day">
                <h2 id="menu-day-title">
                  {day.date === week.today ? "Hoje" : longDayLabel(day.date)} — {week.student.shiftName}
                </h2>
                <DayNotice day={day} week={week} />
                {day.service === "open" && day.items.length === 0 && <p>Nenhum produto no cardápio desta data.</p>}
                {groupItems(day, products).map(([category, items]) => (
                  <section key={category} className="product-section" aria-label={category}>
                    <h3>{category}</h3>
                    <ul className="product-list">
                      {items.map(({ item, product }) => {
                        const online = product.channels.includes("advance");
                        const quantity = values[product.id] ?? 0;
                        return (
                          <li key={product.id} className="product-item" data-testid="product" data-unavailable={!online}>
                            <ProductPhoto productId={product.id} photoPath={product.photoPath} name={product.name} />
                            <div className="product-body">
                              <span className="product-name">{product.name}</span>
                              {product.description && <span className="muted">{product.description}</span>}
                              <div className="product-meta">
                                <span className="product-price">{formatBRL(product.priceCents)}</span>
                                {item.source === "extra" && <span className="tag">Extra do dia</span>}
                                {item.limited && <span className="tag">Quantidade limitada</span>}
                                {!online && <span className="tag tag-off">Só no balcão</span>}
                                {online && buyable && (
                                  <span className="qty" role="group" aria-label={`Quantidade de ${product.name}`}>
                                    <button type="button" className="secondary" aria-label={`Diminuir ${product.name}`} disabled={quantity === 0} onClick={() => change(product.id, -1)}>
                                      −
                                    </button>
                                    <output aria-live="polite">{quantity}</output>
                                    <button type="button" className="secondary" aria-label={`Aumentar ${product.name}`} onClick={() => change(product.id, 1)}>
                                      +
                                    </button>
                                  </span>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      <aside className="summary" aria-label="Resumo da seleção">
        <p>
          <strong data-testid="summary-total">{formatBRL(totalCents)}</strong>{" "}
          <span className="muted">
            · {itemCount} {itemCount === 1 ? "item" : "itens"}
            {day && buyable ? ` · ${dayMonth(day.date)}` : ""}
          </span>
        </p>
        <p className="muted">Prévia: o pagamento com a carteira do aluno será habilitado na etapa de checkout.</p>
      </aside>
    </div>
  );
}
