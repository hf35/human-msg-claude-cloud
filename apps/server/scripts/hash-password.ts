// Prints the value for BACKOFFICE_PASSWORD_HASH: pnpm --filter @human-msg/server hash-password
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../src/admin/password';

const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = process.argv[2] ?? (await rl.question('Password: '));
rl.close();
if (password.length < 8) {
  console.error('The password must have at least 8 characters.');
  process.exit(1);
}
console.log(await hashPassword(password));
