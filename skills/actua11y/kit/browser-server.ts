// Runs outside the audit session's sandbox; the session connects through the private loopback endpoint.
import { chromium } from 'playwright-core';

const channel = process.argv[2];
if (!channel) throw new Error('Pass a browser channel');
const server = await chromium.launchServer({ channel, headless: true, host: '127.0.0.1' });
process.stdout.write(`${server.wsEndpoint()}\n`);
const close = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
