import { invalid } from "@/lib/domain-error";

/**
 * Custo exato em INTEIRO ESCALADO (F10): a unidade é o micro-centavo (1 centavo = 1 000 000; 1 real = 100 000 000).
 * Custo unitário informado em reais com até 4 casas decimais é representável sem erro; o valor total do estoque é a
 * soma exata das entradas menos o custo exato das saídas. Todos os cálculos intermediários usam BigInt (o produto
 * valor × quantidade ultrapassa 2^53) e só o resultado volta a `number` (sempre inteiro seguro, verificado).
 *
 * Método: custo médio móvel ponderado sobre o que AINDA está em estoque (valor ÷ unidades). Cada saída tira
 * `valor × qtd ÷ unidades` arredondado (meio para cima) do valor do estoque; a ÚLTIMA unidade leva todo o valor
 * restante. Assim Σ custo das saídas + valor residual = Σ valor das entradas, sem perder nem criar micro-centavos.
 */
export type Micros = number;

export const MICROS_PER_CENT = 1_000_000;
export const MICROS_PER_REAL = 100 * MICROS_PER_CENT;
export const MAX_UNIT_COST_MICROS = 1_000 * MICROS_PER_REAL; // R$ 1.000,0000 por unidade (teto de sanidade)

const big = (n: number) => BigInt(n);

function safe(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} fora do limite seguro.`);
  return Number(value);
}

/** Divisão inteira com arredondamento meio para cima (valores não negativos). */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new RangeError("Divisão inválida.");
  return (2n * numerator + denominator) / (2n * denominator);
}

/** `a × b ÷ c` arredondado (meio para cima), sem passar por ponto flutuante. */
export function mulDivRound(a: number, b: number, c: number): number {
  return safe(divRound(big(a) * big(b), big(c)), "valor");
}

/**
 * Converte custo unitário em reais ("1,10" ou "1.10"; até 4 casas) para micro-centavos. Recusa zero: custo ausente
 * não vira R$ 0 para esconder cadastro incompleto.
 */
export function parseUnitCost(text: string): Micros {
  const match = /^(\d{1,4})(?:[.,](\d{1,4}))?$/.exec(text.trim());
  if (!match) throw invalid("invalid_cost", "Custo unitário inválido (use até 4 casas decimais).");
  const reais = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(4, "0"));
  const micros = safe(reais * big(MICROS_PER_REAL) + fraction * 10_000n, "custo");
  if (micros <= 0) throw invalid("invalid_cost", "O custo unitário precisa ser maior que zero.");
  if (micros > MAX_UNIT_COST_MICROS) throw invalid("invalid_cost", "Custo unitário acima do limite.");
  return micros;
}

/** Valor total de uma entrada: quantidade × custo unitário (exato). */
export function entryValue(quantity: number, unitCostMicros: Micros): Micros {
  return safe(big(quantity) * big(unitCostMicros), "valor da entrada");
}

/** Custo da saída de `quantity` unidades de um estoque com `onHand` unidades e `valueMicros` de valor (residual preservado). */
export function exitCost(valueMicros: Micros, onHand: number, quantity: number): Micros {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > onHand) throw new RangeError("Quantidade de saída inválida.");
  if (quantity === onHand) return valueMicros; // a última unidade leva o resíduo inteiro
  const cost = mulDivRound(valueMicros, quantity, onHand);
  return Math.min(cost, valueMicros);
}

/** Custo médio unitário (arredondado) para exibição e para o campo informativo do movimento. */
export function averageUnitMicros(valueMicros: Micros, onHand: number): Micros {
  if (onHand <= 0) return 0;
  return safe(divRound(big(valueMicros), big(onHand)), "custo médio");
}

/** Micro-centavos → centavos inteiros (meio para cima). Use uma vez, sobre o total, nunca por unidade. */
export function microsToCents(micros: Micros): number {
  if (micros < 0) return -microsToCents(-micros);
  return safe(divRound(big(micros), big(MICROS_PER_CENT)), "centavos");
}

/** Texto decimal exato em reais (sem arredondar), com pelo menos 2 casas e até 8. Ex.: 105000000 → "1,05". */
export function microsToReaisText(micros: Micros): string {
  const negative = micros < 0;
  const abs = BigInt(Math.abs(micros));
  const reais = abs / big(MICROS_PER_REAL);
  let fraction = (abs % big(MICROS_PER_REAL)).toString().padStart(8, "0").replace(/0+$/, "");
  fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}${reais},${fraction}`;
}

/** Lucro bruto em centavos: receita − custo (CMV) arredondado uma única vez sobre o total da venda. */
export function grossProfitCents(revenueCents: number, cogsMicros: Micros): number {
  return revenueCents - microsToCents(cogsMicros);
}
