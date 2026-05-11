// One-time userbot auth. Run interactively:
//   node scripts/tg-userbot-auth.mjs
// Prompts for phone, SMS code, and 2FA password (if set). Outputs a session
// string — paste into .env as TG_USER_SESSION=... and never share it.

import { readFileSync, writeFileSync } from 'fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

const env = readFileSync('/Users/karaclaycomb/dev/degen-club/.env', 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const apiId = Number(process.env.TG_USER_API_ID);
const apiHash = process.env.TG_USER_API_HASH;

if (!apiId || !apiHash) {
  console.error('Missing TG_USER_API_ID or TG_USER_API_HASH in .env');
  process.exit(1);
}

const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => await input.text('Phone (with country code, e.g. +14155551234): '),
  password: async () => await input.text('2FA password (leave blank if none): '),
  phoneCode: async () => await input.text('Code from Telegram: '),
  onError: (err) => console.error(err),
});

const sessionString = client.session.save();
console.log('\n=== SESSION STRING ===');
console.log(sessionString);
console.log('======================\n');
console.log('Adding to .env as TG_USER_SESSION...');

const lines = readFileSync('/Users/karaclaycomb/dev/degen-club/.env', 'utf8').split('\n');
const filtered = lines.filter((l) => !l.startsWith('TG_USER_SESSION='));
filtered.push(`TG_USER_SESSION=${sessionString}`);
writeFileSync('/Users/karaclaycomb/dev/degen-club/.env', filtered.join('\n'));
console.log('Saved to .env.');
await client.disconnect();
process.exit(0);
