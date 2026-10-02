import { cleanupCloudAccounts } from "../helpers/cloud.ts";

/** Remove as contas efêmeras criadas pela execução (fixtures duráveis ficam). */
export default async function globalTeardown(): Promise<void> {
  console.log(`teardown: ${await cleanupCloudAccounts()} conta(s) efêmera(s) removida(s)`);
}
