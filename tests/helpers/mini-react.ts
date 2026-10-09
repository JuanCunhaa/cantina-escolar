// Mini-renderizador de teste (sem DOM): expande componentes de função chamando-os com um "dispatcher" de hooks próprio e devolve a
// árvore de elementos, para que os testes de unidade DISPAREM os manipuladores (onChange, onClick, onSubmit) dos formulários e dos
// contêineres e verifiquem o resultado. Suporta o que as telas do caixa/financeiro usam: useState, useRef, useMemo, useCallback,
// useEffect/useLayoutEffect (sem efeito), useId. Não substitui o navegador (e2e): só exercita a lógica de interface em Node.
import * as React from "react";

type Props = Record<string, unknown>;
export type Node = { type: string; props: Props; children: Node[]; text?: string };

type Internals = { H: unknown };
const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Internals }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

export type Harness = {
  tree: () => Node;
  /** Re-renderiza a partir do estado atual. */
  render: () => Node;
  find: (predicate: (n: Node) => boolean) => Node;
  findAll: (predicate: (n: Node) => boolean) => Node[];
  byTestId: (id: string) => Node;
  byId: (id: string) => Node;
  text: () => string;
  change: (node: Node, value: string | boolean) => Promise<void>;
  click: (node: Node) => Promise<void>;
  submit: (node: Node) => Promise<void>;
};

const textOf = (n: Node): string => (n.text !== undefined ? n.text : n.children.map(textOf).join(" ")).replace(/\s+/g, " ").trim();

export function mount(Root: (props: never) => unknown, rootProps: Props = {}): Harness {
  const slots = new Map<string, unknown[]>();
  let current: Node = { type: "root", props: {}, children: [] };
  let path = "";
  let index = 0;
  let dirty = false;

  const dispatcher = {
    useState(initial: unknown) {
      const key = path;
      const store = slots.get(key) ?? [];
      slots.set(key, store);
      const i = index++;
      if (!(i in store)) store[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (v: unknown) => unknown)(store[i]) : next;
        if (!Object.is(value, store[i])) {
          store[i] = value;
          dirty = true;
        }
      };
      return [store[i], set];
    },
    useRef(initial: unknown) {
      const store = slots.get(path) ?? [];
      slots.set(path, store);
      const i = index++;
      if (!(i in store)) store[i] = { current: initial };
      return store[i];
    },
    useMemo: (fn: () => unknown) => {
      index++;
      return fn();
    },
    useCallback: (fn: unknown) => {
      index++;
      return fn;
    },
    useEffect: () => {
      index++;
    },
    useLayoutEffect: () => {
      index++;
    },
    useId: () => `id-${path}`,
    useDebugValue: () => undefined,
  };

  function expand(node: unknown, at: string): Node[] {
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number") return [{ type: "#text", props: {}, children: [], text: String(node) }];
    if (Array.isArray(node)) return node.flatMap((child, i) => expand(child, `${at}[${i}]`));
    const el = node as { type: unknown; props: Props; key?: string | null };
    if (typeof el.type === "symbol") return expand(el.props.children, at); // Fragment
    if (typeof el.type === "string") return [{ type: el.type, props: el.props, children: expand(el.props.children, `${at}/${el.type}`) }];
    if (typeof el.type === "function") {
      const savedPath = path;
      const savedIndex = index;
      path = `${at}/${(el.type as { name?: string }).name ?? "C"}${el.key ? `:${el.key}` : ""}`;
      index = 0;
      const out = (el.type as (p: Props) => unknown)(el.props);
      const here = path;
      path = savedPath;
      index = savedIndex;
      return expand(out, here);
    }
    return [];
  }

  function render(): Node {
    for (let guard = 0; guard < 20; guard++) {
      dirty = false;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        const nodes = expand(React.createElement(Root as React.ComponentType<Props>, rootProps), "root");
        current = { type: "root", props: {}, children: nodes };
      } finally {
        internals.H = previous;
      }
      if (!dirty) break;
    }
    return current;
  }

  const findAll = (predicate: (n: Node) => boolean, from: Node = current): Node[] => [...(predicate(from) ? [from] : []), ...from.children.flatMap((c) => findAll(predicate, c))];
  const find = (predicate: (n: Node) => boolean): Node => {
    const found = findAll(predicate)[0];
    if (!found) throw new Error("elemento não encontrado na árvore");
    return found;
  };
  const flush = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    render();
  };

  render();
  return {
    tree: () => current,
    render,
    find,
    findAll,
    byTestId: (id) => find((n) => n.props["data-testid"] === id),
    byId: (id) => find((n) => n.props.id === id),
    text: () => textOf(current),
    async change(node, value) {
      const handler = node.props.onChange as ((e: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`sem onChange: ${node.type}`);
      await handler({ target: { value: typeof value === "string" ? value : "", checked: value === true } });
      await flush();
    },
    async click(node) {
      const handler = node.props.onClick as (() => unknown) | undefined;
      if (!handler) throw new Error(`sem onClick: ${node.type}`);
      await handler();
      await flush();
    },
    async submit(node) {
      const handler = node.props.onSubmit as ((e: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`sem onSubmit: ${node.type}`);
      await handler({ preventDefault: () => undefined });
      await flush();
    },
  };
}

export { textOf };
