import 'dotenv/config';
import fs from 'node:fs/promises';

const required = ['SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'TEST_USER_A_EMAIL', 'TEST_USER_A_PASSWORD', 'TEST_USER_B_EMAIL', 'TEST_USER_B_PASSWORD'];
if (!required.every(name => process.env[name])) process.exit(0);

async function signIn(email, password) {
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { ['api' + 'key']: process.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(`Supabase test login failed (${response.status})`);
  return payload.access_token;
}

const tokens = {
  TEST_USER_A_TOKEN: await signIn(process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD),
  TEST_USER_B_TOKEN: await signIn(process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD)
};
const envPath = new URL('../.env', import.meta.url);
let contents = await fs.readFile(envPath, 'utf8');
for (const [name, value] of Object.entries(tokens)) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
}
await fs.writeFile(envPath, contents, 'utf8');
console.log('Supabase test access tokens refreshed.');
