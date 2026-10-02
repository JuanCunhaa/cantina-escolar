import { expect, test, type Browser, type Page } from "@playwright/test";
import { createTestUser, TEST_PASSWORD } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

async function login(page: Page, path: string, email: string, password: string = TEST_PASSWORD) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const tag = Math.random().toString(36).slice(2, 7);

test.describe.configure({ mode: "serial" });

// Rotas e páginas compiladas antes dos fluxos (ver tests/helpers/dev-server.ts): evita recarga das páginas abertas e
// navegação interrompida no servidor de desenvolvimento.
test.beforeAll(async ({ request }) => {
  await warmRoutes(request, {
    post: ["/api/school", "/api/students", "/api/students/import", "/api/policies", "/api/links", "/api/invitations", "/api/invitations/redeem", "/api/guardians", "/api/students/x"],
    get: ["/operacao/alunos", "/operacao/alunos/importar", "/operacao/alunos/x", "/operacao/escola", "/operacao/responsaveis", "/portal/alunos", "/convite"],
  });
});

test("administração: turmas, turnos, alunos (homônimos com turma/turno) e importação CSV pela interface", async ({ page }) => {
  const admin = await createTestUser("e2e-adm4", "admin");
  await login(page, "/operacao/escola", admin.email);
  await expect(page.getByRole("heading", { name: "Turmas e turnos" })).toBeVisible({ timeout: 20000 });

  await page.locator("#new-class").fill(`5A ${tag}`);
  await page.getByTestId("units-class").getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByTestId("units-class").getByRole("cell", { name: `5A ${tag}`, exact: true })).toBeVisible();
  await page.locator("#new-class").fill(`6B ${tag}`);
  await page.getByTestId("units-class").getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByTestId("units-class").getByRole("cell", { name: `6B ${tag}`, exact: true })).toBeVisible();
  // Nome repetido (ignorando caixa) é recusado com mensagem humana.
  await page.locator("#new-class").fill(`5a ${tag}`);
  await page.getByTestId("units-class").getByRole("button", { name: "Adicionar" }).click();
  await expect(page.locator("#conteudo").getByRole("alert")).toContainText("Já existe outra turma/turno com este nome");
  await page.locator("#new-shift").fill(`Manhã ${tag}`);
  await page.getByTestId("units-shift").getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByTestId("units-shift").getByRole("cell", { name: `Manhã ${tag}`, exact: true })).toBeVisible();

  // Dois alunos homônimos em turmas diferentes.
  await page.goto("/operacao/alunos");
  for (const [enrollment, cls] of [[`E${tag}1`, `5A ${tag}`], [`E${tag}2`, `6B ${tag}`]]) {
    await page.locator("#new-enrollment").fill(enrollment!);
    await page.locator("#new-name").fill(`Joana Prado ${tag}`);
    await page.locator("#new-class").selectOption({ label: cls! });
    await page.locator("#new-shift").selectOption({ label: `Manhã ${tag}` });
    await page.getByRole("button", { name: "Cadastrar aluno" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Aluno cadastrado." })).toBeVisible();
  }
  // Matrícula repetida: mensagem de erro.
  await page.locator("#new-enrollment").fill(`e${tag}1`);
  await page.locator("#new-name").fill("Outra Pessoa");
  await page.locator("#new-class").selectOption({ label: `5A ${tag}` });
  await page.locator("#new-shift").selectOption({ label: `Manhã ${tag}` });
  await page.getByRole("button", { name: "Cadastrar aluno" }).click();
  await expect(page.locator("#conteudo").getByRole("alert")).toContainText("Esta matrícula já está cadastrada");

  await page.locator("#filter-text").fill(`joana prado ${tag}`);
  const rows = page.getByTestId("student-row");
  await expect(rows).toHaveCount(2);
  const texts = await rows.allTextContents();
  expect(texts.filter((t) => t.includes(`5A ${tag}`) && t.includes(`Manhã ${tag}`))).toHaveLength(1);
  expect(texts.filter((t) => t.includes(`6B ${tag}`) && t.includes(`Manhã ${tag}`))).toHaveLength(1);

  // Importação CSV: prévia (nada gravado) -> erro bloqueia -> corrigido -> confirma.
  await page.goto("/operacao/alunos/importar");
  const bad = `matrícula;nome;turma;turno\nI${tag}1;Pedro Lima ${tag};5A ${tag};Manhã ${tag}\nI${tag}2;Turma Errada;Fantasma;Manhã ${tag}`;
  await page.locator("#csv-text").fill(bad);
  await page.getByRole("button", { name: "Gerar prévia" }).click();
  await expect(page.getByTestId("import-summary")).toContainText("1 a criar");
  await expect(page.getByTestId("import-summary")).toContainText("1 com erro");
  await expect(page.getByText("Turma não cadastrada.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();
  const good = `matrícula;nome;turma;turno\nI${tag}1;Pedro Lima ${tag};5A ${tag};Manhã ${tag}\nI${tag}3;Pedro Lima ${tag};5A ${tag};Manhã ${tag}\nE${tag}1;Joana Prado ${tag};5A ${tag};Manhã ${tag}`;
  await page.locator("#csv-text").fill(good);
  await page.getByRole("button", { name: "Gerar prévia" }).click();
  await expect(page.getByTestId("import-summary")).toContainText("2 a criar");
  await expect(page.getByTestId("import-summary")).toContainText("1 ignoradas");
  await expect(page.getByTestId("import-summary")).toContainText("1 com aviso");
  await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled(); // aviso exige confirmação
  await page.getByLabel(/Confirmo que as linhas com aviso/).check();
  await page.getByRole("button", { name: "Confirmar importação" }).click();
  await expect(page.getByTestId("import-result")).toContainText("2 criados");
  await page.goto("/operacao/alunos");
  await page.locator("#filter-text").fill(`pedro lima ${tag}`);
  await expect(page.getByTestId("student-row")).toHaveCount(2);
});

// Regressão da intermitência vista no CI (F06, "turma duplicada" sem alerta em 5 s): o listener mostra a turma nova ANTES
// da resposta HTTP do envio; se o campo aceitasse digitação nesse intervalo, a limpeza pós-envio apagaria o texto novo e
// o clique seguinte enviaria campo vazio (barrado pelo `required`, sem alerta). Segurar a resposta torna a corrida certa.
test("turmas: o que se digita durante um envio pendente não é descartado; nome repetido mostra o erro (regressão)", async ({ page }) => {
  const admin = await createTestUser("e2e-adm4-corrida", "admin");
  await login(page, "/operacao/escola", admin.email);
  await expect(page.getByRole("heading", { name: "Turmas e turnos" })).toBeVisible({ timeout: 20000 });
  const classes = page.getByTestId("units-class");
  await page.route("**/api/school", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await page.locator("#new-class").fill(`7C ${tag}`);
  await classes.getByRole("button", { name: "Adicionar" }).click();
  await expect(classes.getByRole("cell", { name: `7C ${tag}`, exact: true })).toBeVisible();
  await page.locator("#new-class").fill(`7c ${tag}`);
  await classes.getByRole("button", { name: "Adicionar" }).click();
  await expect(classes.getByRole("alert")).toContainText("Já existe outra turma/turno com este nome");
});

async function newContextPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test("convite de uso único: responsável cria conta, vê só o próprio aluno e altera permissões; segundo uso é recusado", async ({ page, browser }) => {
  const admin = await createTestUser("e2e-adm4b", "admin");
  await login(page, "/operacao/alunos", admin.email);
  await page.locator("#filter-text").fill(`joana prado ${tag}`);
  await page.getByTestId("student-row").first().getByRole("link").click();
  await expect(page.getByRole("heading", { name: `Joana Prado ${tag}` })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Nenhum responsável vinculado.")).toBeVisible();

  await page.getByRole("button", { name: "Convidar responsável" }).click();
  const link = page.locator("#issued-link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/\/convite#[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId("invitation-row")).toContainText("Pendente");

  // Quem recebe o link (sem conta) cria a conta e cai no portal.
  const { context, page: guest } = await newContextPage(browser);
  await guest.goto(url);
  await expect(guest.getByRole("heading", { name: "Convite da Cantina Escolar" })).toBeVisible({ timeout: 30000 });
  await guest.getByLabel("Seu nome completo").fill(`Mãe da Joana ${tag}`);
  await guest.getByLabel("Email").fill(`mae-${tag}@example.test`);
  await guest.getByLabel(/Senha/).fill(TEST_PASSWORD);
  await guest.getByRole("button", { name: "Criar conta e aceitar convite" }).click();
  // O servidor de desenvolvimento pode recarregar a página ao compilar a rota seguinte; nesse caso a conta já existe,
  // o convite já foi usado por ela e "Aceitar convite" repete o resgate com a mesma conta (replay do dono).
  const portal = guest.getByRole("heading", { name: "Portal da família" });
  const accept = guest.getByRole("button", { name: "Aceitar convite com esta conta" });
  await expect(portal.or(accept)).toBeVisible({ timeout: 30000 });
  if (await accept.isVisible()) await accept.click();
  await expect(portal).toBeVisible({ timeout: 30000 });

  await guest.goto("/portal/alunos");
  const student = guest.getByTestId("family-student");
  await expect(student).toHaveCount(1, { timeout: 30000 });
  await expect(student).toContainText(`Joana Prado ${tag}`);
  await expect(student).toContainText(new RegExp(`(5A|6B) ${tag} · Manhã ${tag}`)); // turma e turno do filho vinculado
  const site = guest.getByLabel("Aluno pode comprar pelo site");
  await expect(site).not.toBeChecked();
  await site.click(); // controlado: só muda quando o servidor confirma e o listener atualiza
  await expect(guest.getByRole("status").filter({ hasText: "Permissão atualizada" })).toBeVisible();
  await expect(site).toBeChecked();
  await guest.setViewportSize({ width: 375, height: 800 });
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await guest.screenshot({ path: "test-results/f04-portal-alunos-375.png", fullPage: true });

  // O link já usado não vale mais, mesmo para outra pessoa.
  const second = await newContextPage(browser);
  await second.page.goto(url);
  await second.page.getByLabel("Seu nome completo").fill("Outra Pessoa");
  await second.page.getByLabel("Email").fill(`outra-${tag}@example.test`);
  await second.page.getByLabel(/Senha/).fill(TEST_PASSWORD);
  await second.page.getByRole("button", { name: "Criar conta e aceitar convite" }).click();
  await expect(second.page.locator("#conteudo").getByRole("alert")).toContainText("Convite inválido, expirado ou já utilizado");
  await second.context.close();

  // Administração vê o vínculo e a permissão; o convite aparece como usado.
  await page.reload();
  await expect(page.getByTestId("guardian-links")).toContainText(`Mãe da Joana ${tag}`);
  await expect(page.getByTestId("invitation-row")).toContainText("Usado");
  await expect(page.getByText("Compra pelo site: permitida")).toBeVisible();
  await page.screenshot({ path: "test-results/f04-ficha-aluno.png", fullPage: true });

  // Responsável sem vínculo (outro filho) não vê Joana.
  const other = await createTestUser("e2e-resp-sem", "guardian");
  const { context: c3, page: p3 } = await newContextPage(browser);
  await login(p3, "/portal/alunos", other.email);
  await expect(p3.getByText("Nenhum aluno vinculado à sua conta ainda")).toBeVisible({ timeout: 20000 });
  await expect(p3.getByTestId("family-student")).toHaveCount(0);
  await c3.close();
  await context.close();
});

test("perfis sem permissão: cantina e secretaria consultam a lista sem cadastrar; responsável não acessa a operação", async ({ browser }) => {
  for (const role of ["cantina", "secretaria"] as const) {
    const user = await createTestUser(`e2e-${role}4`, role);
    const { context, page } = await newContextPage(browser);
    await login(page, "/operacao/alunos", user.email);
    await expect(page.getByRole("heading", { name: "Alunos", exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("student-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Cadastrar aluno" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Importar CSV" })).toHaveCount(0);
    await page.goto("/operacao/escola");
    await expect(page.getByText("Somente a administração cadastra turmas e turnos.")).toBeVisible();
    await context.close();
  }
  const guardian = await createTestUser("e2e-resp4", "guardian");
  const { context, page } = await newContextPage(browser);
  await login(page, "/operacao/alunos", guardian.email);
  await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible({ timeout: 20000 });
  await context.close();
});
