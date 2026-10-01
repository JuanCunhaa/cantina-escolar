import { describe, expect, it } from "vitest";
import { formatBRL } from "@/lib/money/format";
import { PHOTO_MAX_BYTES, PHOTO_PATH_PATTERN, productPhotoPath, validatePhoto } from "@/lib/validation/photo";
import { NAV_ITEMS, homeFor, navigationFor } from "@/modules/access/navigation";
import { canManagePhotos, parseRole, ROLES } from "@/modules/access/roles";

describe("validatePhoto (A36)", () => {
  it("aceita JPEG/PNG/WebP até 2 MB", () => {
    expect(validatePhoto({ type: "image/jpeg", size: 1000 })).toMatchObject({ ok: true, extension: "jpg" });
    expect(validatePhoto({ type: "image/png", size: PHOTO_MAX_BYTES })).toMatchObject({ ok: true, extension: "png" });
    expect(validatePhoto({ type: "image/webp", size: 1 })).toMatchObject({ ok: true, extension: "webp" });
  });
  it("recusa SVG, PDF, vazio e acima do limite", () => {
    for (const type of ["image/svg+xml", "application/pdf", "text/html", ""]) {
      expect(validatePhoto({ type, size: 100 }).ok).toBe(false);
    }
    expect(validatePhoto({ type: "image/png", size: 0 }).ok).toBe(false);
    expect(validatePhoto({ type: "image/png", size: PHOTO_MAX_BYTES + 1 }).ok).toBe(false);
  });
  it("caminho gerado casa com o padrão do servidor e rejeita travessia", () => {
    expect(PHOTO_PATH_PATTERN.test(productPhotoPath("demo-suco", "abc123", "png"))).toBe(true);
    for (const bad of ["products/../private/x.png", "products/a/b/c.png", "private/a.png", "products/a/b.svg", "products/a/.png"]) {
      expect(PHOTO_PATH_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("navegação por papel (A37)", () => {
  it("responsável só vê portal; equipe só vê operação", () => {
    expect(navigationFor("guardian").every((i) => i.href.startsWith("/portal"))).toBe(true);
    for (const role of ["cantina", "secretaria", "admin"] as const) {
      expect(navigationFor(role).every((i) => i.href.startsWith("/operacao"))).toBe(true);
    }
  });
  it("secretaria não vê PDV nem produtos; admin vê o painel que cantina não vê", () => {
    const secretaria = navigationFor("secretaria").map((i) => i.href);
    expect(secretaria).not.toContain("/operacao/pdv");
    expect(secretaria).not.toContain("/operacao/produtos");
    expect(navigationFor("cantina").map((i) => i.href)).not.toContain("/operacao/painel");
    expect(navigationFor("admin").map((i) => i.href)).toContain("/operacao/painel");
  });
  it("todo papel tem item e a página inicial aponta para item pronto do próprio papel", () => {
    for (const role of ROLES) {
      expect(navigationFor(role).length).toBeGreaterThan(0);
      const home = navigationFor(role).find((i) => i.href === homeFor(role));
      expect(home?.ready, role).toBe(true);
    }
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });
});

describe("papéis e dinheiro", () => {
  it("parseRole ignora valores desconhecidos; só admin/cantina gerenciam fotos", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("root")).toBeNull();
    expect(parseRole(undefined)).toBeNull();
    expect(canManagePhotos("guardian")).toBe(false);
    expect(canManagePhotos("secretaria")).toBe(false);
    expect(canManagePhotos(null)).toBe(false);
    expect(canManagePhotos("cantina")).toBe(true);
    expect(canManagePhotos("admin")).toBe(true);
  });
  it("formata centavos em BRL", () => {
    expect(formatBRL(450).replace(/\s/g, " ")).toBe("R$ 4,50");
    expect(formatBRL(0).replace(/\s/g, " ")).toBe("R$ 0,00");
  });
});
