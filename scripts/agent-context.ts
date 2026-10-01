// Utilitário de contexto local; Node 24.12+ executa TS sem dependências.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

type Task = {
  id: string; title: string; phase: string; path: string;
  depends_on: string[]; docs: string[]; acceptance: string[];
  skill_workflow: { stage: string; skill: string; purpose: string }[];
  conditional_skills: { when: string; skill: string }[];
};
type Map = { tasks: Task[]; domains: Record<string,string[]>; acceptance: Record<string,string> };
const root = fileURLToPath(new URL('../', import.meta.url));
const request = process.argv[2];
if (!request) {
  console.error('Uso: node scripts/agent-context.ts F11 | domain:wallet');
  process.exit(2);
}
try {
  const map: Map = JSON.parse(readFileSync(resolve(root, 'docs/context-map.json'), 'utf8'));
  if (request.startsWith('domain:')) {
    const domain = request.slice(7);
    const docs = Object.hasOwn(map.domains, domain) ? map.domains[domain] : undefined;
    if (!docs) throw new Error('Domínio desconhecido. Consultar docs/context-map.json.');
    console.log(JSON.stringify({ domain, docs }, null, 2));
  } else {
    const task = map.tasks.find(t => t.id === request.toUpperCase());
    if (!task) throw new Error('Tarefa desconhecida. Consultar docs/tasks/index.md.');
    const testFiles = [...new Set(task.acceptance.map(id => map.acceptance[id]))];
    console.log(JSON.stringify({ ...task, test_files: testFiles }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
