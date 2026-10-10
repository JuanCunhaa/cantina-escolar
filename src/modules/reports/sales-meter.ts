/**
 * Medidor de leituras do relatório de vendas (F21): conta, no servidor, os documentos que cada abertura consulta, por etiqueta.
 * É uma ESTIMATIVA do que a aplicação pediu ao Firestore — NÃO é a cobrança oficial, que só o console/faturamento do Firebase mostra.
 *
 * INCLUI: documentos devolvidos por cada consulta (mínimo 1 por consulta, mesmo vazia); documentos lidos por ID (`getAll`/`get`);
 * AGREGAÇÕES `count()`/`sum()` a 1 leitura por 1 000 entradas de índice correspondidas, mínimo 1 por agregação — o custo de uma
 * contagem CRESCE com o volume (um dia com 3 200 movimentos custa 4 leituras só na contagem de movimentos), aqui estimado pelo próprio
 * resultado da contagem (para consultas só por intervalo de `createdAt`, entradas de índice = documentos correspondentes); a listagem
 * de partes existentes (1 por documento); a leitura do perfil do ator na autenticação (1 por chamada); e os recebimentos da F20
 * (estimados pelo número de recebimentos devolvidos).
 * EXCLUI: escritas (contadas à parte, `estimatedWrites`); leituras do Auth; as demais leituras de uma requisição fora do relatório
 * (login, perfil no navegador, outras telas); leituras que o F20 faz e descarta (recebimentos não confirmados, por exemplo — a
 * estimativa dos recebimentos pode ficar abaixo do real); entradas de índice de consultas com mais de um filtro de igualdade
 * (a cobrança de agregação com filtro composto pode diferir do número de documentos); novas tentativas internas do cliente; o
 * emulador (que não cobra). Use para comparar operações e orçar a cota, nunca como fatura.
 */
export type ReadStats = { estimatedReads: number; estimatedWrites: number; byLabel: Record<string, number> };

export class ReadMeter {
  private total = 0;
  private writes = 0;
  private readonly labels: Record<string, number> = {};

  /** `n` documentos lidos sob a etiqueta. */
  read(label: string, n: number): void {
    const count = Math.max(0, Math.trunc(n));
    this.total += count;
    this.labels[label] = (this.labels[label] ?? 0) + count;
  }

  /** Consulta que devolveu `size` documentos: custa no mínimo 1 leitura mesmo vazia. */
  query(label: string, size: number): void {
    this.read(label, Math.max(1, size));
  }

  /** Agregação (count/sum): 1 leitura por 1 000 entradas de índice, no mínimo 1. */
  aggregate(label: string, matched: number): void {
    this.read(label, Math.max(1, Math.ceil(matched / 1000)));
  }

  write(n: number): void {
    this.writes += n;
  }

  snapshot(): ReadStats {
    return { estimatedReads: this.total, estimatedWrites: this.writes, byLabel: { ...this.labels } };
  }
}
