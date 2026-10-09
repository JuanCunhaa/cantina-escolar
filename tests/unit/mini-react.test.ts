// Teste do PRÓPRIO mini-renderizador (tests/helpers/mini-react.ts): garante que ele não dá falsa confiança — o estado persiste entre
// renderizações, os manipuladores recebem o evento certo, listas com `key` guardam estado separado e elementos/handlers ausentes
// FALHAM (em vez de passar em silêncio). Ele exercita a lógica de interface em Node; a prova de interação REAL no navegador continua
// sendo `tests/e2e/finance.spec.ts` (Playwright).
import { createElement, useMemo, useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "../helpers/mini-react";

function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  useRef(0); // o gancho existe no renderizador (a leitura de `.current` durante a renderização é proibida pelas regras do projeto)
  const doubled = useMemo(() => n * 2, [n]);
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "label" }, label),
    createElement("output", { id: "n" }, `n=${n} dobro=${doubled}`),
    createElement("button", { id: "inc", onClick: () => setN((v) => v + 1) }, "mais"),
    createElement("input", { id: "text", value: String(n), onChange: (e: { target: { value: string } }) => setN(Number(e.target.value)) }),
    createElement("form", { id: "f", onSubmit: async (e: { preventDefault: () => void }) => { e.preventDefault(); await Promise.resolve(); setN(100); } }),
  );
}

function List() {
  return createElement("ul", null, ["a", "b"].map((k) => createElement(Counter, { key: k, label: k })));
}

describe("mini-react (apoio dos testes de interface)", () => {
  it("estado persiste, o evento chega com o valor e o submit assíncrono é aguardado", async () => {
    const h = mount(Counter as never, { label: "x" });
    expect(h.text()).toContain("n=0 dobro=0");
    await h.click(h.byId("inc"));
    await h.click(h.byId("inc"));
    expect(h.text()).toContain("n=2 dobro=4");
    await h.change(h.byId("text"), "7");
    expect(h.text()).toContain("n=7 dobro=14");
    await h.submit(h.byId("f")); // o manipulador espera uma microtarefa antes de mudar o estado
    expect(h.text()).toContain("n=100 dobro=200");
  });

  it("componentes irmãos com `key` têm estado separado", async () => {
    const h = mount(List as never);
    const buttons = h.findAll((n) => n.props.id === "inc");
    expect(buttons).toHaveLength(2);
    await h.click(buttons[0]!);
    const outputs = h.findAll((n) => n.type === "output").map((n) => n.children[0]!.text);
    expect(outputs[0]).toContain("n=1");
    expect(outputs[1]).toContain("n=0");
  });

  it("não dá falsa confiança: elemento inexistente e manipulador ausente FALHAM", async () => {
    const h = mount(Counter as never, { label: "x" });
    expect(() => h.byId("nao-existe")).toThrow("elemento não encontrado");
    expect(() => h.byTestId("nao-existe")).toThrow();
    await expect(h.click(h.byTestId("label"))).rejects.toThrow("sem onClick");
    await expect(h.change(h.byTestId("label"), "x")).rejects.toThrow("sem onChange");
    await expect(h.submit(h.byTestId("label"))).rejects.toThrow("sem onSubmit");
  });

  it("não renderiza o que não existe: nulo, falso e vazio somem; texto e números aparecem", () => {
    const h = mount((() => createElement("p", null, null, false, undefined, 5, "ok")) as never);
    expect(h.text()).toBe("5 ok");
  });
});
