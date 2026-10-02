// MEDIÇÃO DA APLICAÇÃO (investigação do atraso de listener; não é teste de aceite nem roda no verify): mesmos marcos da reprodução mínima na
// tela do calendário. Grava só tempos, nomes de parâmetros e hashes de sessão (sem valores) em tools/listener-repro/results.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { makePng } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, TEST_PASSWORD } from "../../tests/helpers/auth-emulator";
import { createTempProduct, retireTempProduct } from "../../tests/helpers/catalog-fixtures.ts";

test("medição: foto do produto (app) — envio, listener, leitura e carga da imagem", async ({ browser, request }) => {
  test.setTimeout(900_000);
  const admin = await createTestUser("hml-medicao-foto", "admin");
  const results: Record<string, unknown>[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const name = `Medição foto ${run} ${Date.now() % 100000}`;
    const id = await createTempProduct(request, admin.idToken, name);
    const context = await browser.newContext();
    const page = await context.newPage();
    let photoGetStart = 0;
    let photoGetEnd = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/catalog/photo") && r.method() === "GET" && r.url().includes(id) && !photoGetStart) photoGetStart = Date.now();
    });
    page.on("requestfinished", (r) => {
      if (r.url().includes("/api/catalog/photo") && r.method() === "GET" && r.url().includes(id) && !photoGetEnd) photoGetEnd = Date.now();
    });
    try {
      await page.goto("/operacao/produtos");
      await page.getByLabel("Email").fill(admin.email);
      await page.getByLabel("Senha").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Entrar" }).click();
      const row = page.getByTestId("photo-row").filter({ hasText: name });
      await expect(row.locator('[data-fallback="true"]')).toBeVisible({ timeout: 60_000 });
      const tListReady = Date.now();
      await page.waitForTimeout(2000);
      const tUpload = Date.now();
      await page.getByLabel(`Enviar foto de ${name}`).setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: makePng(240, 180, [90, 140, 200]) });
      await expect(row.getByRole("status").filter({ hasText: "Foto atualizada." })).toBeVisible({ timeout: 60_000 });
      const tConfirmed = Date.now();
      // Janela de MEDIÇÃO (até 60 s): a linha troca o fallback pela foto depois que o listener traz o photoPath novo.
      await expect(row.locator(".photo img")).toHaveJSProperty("complete", true, { timeout: 60_000 });
      const tImage = Date.now();
      const result = {
        run,
        listReadyToUploadMs: tUpload - tListReady,
        uploadToConfirmedMs: tConfirmed - tUpload,
        confirmedToPhotoGetStartMs: photoGetStart ? photoGetStart - tConfirmed : null,
        photoGetMs: photoGetStart && photoGetEnd ? photoGetEnd - photoGetStart : null,
        confirmedToImageMs: tImage - tConfirmed,
      };
      results.push(result);
      console.log(`#foto${run} envio→confirmação=${result.uploadToConfirmedMs} ms | confirmação→GET foto=${result.confirmedToPhotoGetStartMs} ms | GET=${result.photoGetMs} ms | confirmação→imagem=${result.confirmedToImageMs} ms`);
    } finally {
      await context.close();
      await retireTempProduct(request, admin.idToken, id);
    }
  }
  mkdirSync("tools/listener-repro/results", { recursive: true });
  writeFileSync(`tools/listener-repro/results/${new Date().toISOString().replace(/[:.]/g, "-")}-APP-foto-${process.env.STAGING_PUBLISHED_URL ? "publicada" : "local"}.json`, JSON.stringify({ scenario: "APP-foto", runs: results }, null, 1));
});

const RUNS = Number(process.env.MEASURE_RUNS ?? "4");

test("medição: tela do calendário (app)", async ({ browser }) => {
  test.setTimeout(900_000);
  const admin = await createTestUser("hml-medicao", "admin");
  const results: Record<string, unknown>[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const starts: { kind: string; at: number; params: string; method: string; session: string }[] = [];
    const other: { host: string; path: string; at: number }[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("/channel")) {
        const kind = url.searchParams.get("TYPE") === "xmlhttp" ? "BACK" : url.searchParams.get("TYPE") === "terminate" ? "TERMINATE" : "FWD";
        const sid = url.searchParams.get("SID");
        starts.push({
          kind: `${url.pathname.includes("Write/") ? "WRITE-" : ""}${kind}`,
          at: Date.now(),
          method: request.method(),
          params: [...new Set(url.searchParams.keys())].filter((k) => k !== "zx" && k !== "t").sort().join(","),
          session: sid ? createHash("sha256").update(sid).digest("hex").slice(0, 6) : "-",
        });
      } else if (/googleapis\.com/.test(url.host)) other.push({ host: url.host, path: url.pathname.replace(/[A-Za-z0-9_-]{20,}/g, "<id>"), at: Date.now() });
    });
    const t0 = Date.now();
    await page.goto("/operacao/calendario");
    await page.getByLabel("Email").fill(admin.email);
    await page.getByLabel("Senha").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    const days = page.getByTestId("calendar-days");
    await expect(days).toBeVisible({ timeout: 60_000 });
    const tVisible = Date.now();
    await expect(days.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0, { timeout: 60_000 });
    const tFirstSnapshot = Date.now();
    await page.waitForTimeout(2000);
    const date = `2027-0${1 + (run % 8)}-1${run % 10}`;
    const reason = `Medição ${run} ${Date.now() % 100000}`;
    await days.getByLabel("Data").fill(date);
    await days.getByLabel("Motivo").fill(reason);
    await days.getByRole("button", { name: "Salvar dia" }).click();
    await expect(days.getByRole("status").filter({ hasText: "Dia salvo" })).toBeVisible({ timeout: 60_000 });
    const tCommitConfirmed = Date.now();
    // Janela de MEDIÇÃO (até 60 s), não asserção de aceite.
    await expect(days.getByRole("cell", { name: reason })).toBeVisible({ timeout: 60_000 });
    const tRow = Date.now();
    await days.getByRole("button", { name: `Remover ${date}` }).click();
    await expect(days.getByRole("cell", { name: reason })).toHaveCount(0, { timeout: 60_000 });
    await context.close();
    const channelOpen = starts[0]?.at ?? t0;
    const result = {
      run,
      gotoToVisibleMs: tVisible - t0,
      visibleToFirstSnapshotMs: tFirstSnapshot - tVisible,
      commitConfirmedToRowMs: tRow - tCommitConfirmed,
      channelOpenToRowMs: tRow - channelOpen,
      sessions: [...new Set(starts.map((s) => s.session).filter((s) => s !== "-"))].length,
      requestStarts: starts.map((s) => ({ ...s, at: s.at - channelOpen })),
      otherGoogleRequests: other.map((o) => ({ ...o, at: o.at - channelOpen })),
    };
    results.push(result);
    console.log(`#${run} confirmação→linha=${result.commitConfirmedToRowMs} ms | canal aberto→linha=${result.channelOpenToRowMs} ms | requisições do canal=${starts.length} | sessões=${result.sessions}`);
  }
  mkdirSync("tools/listener-repro/results", { recursive: true });
  writeFileSync(`tools/listener-repro/results/${new Date().toISOString().replace(/[:.]/g, "-")}-APP-calendario-${process.env.STAGING_PUBLISHED_URL ? "publicada" : "local"}.json`, JSON.stringify({ scenario: "APP-calendario", runs: results }, null, 1));
});
