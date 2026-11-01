import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foldersOverlap, loadConfig, LOOPBACK } from './config.js';
import { createApp } from './app.js';
import { UserStore, validName } from './services/users.js';

let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`Outpost can't start: ${(e as Error).message}\nFix it in ~/.config/outpost/env, then start Outpost again.`);
  process.exit(1);
}
const codeDir = fileURLToPath(new URL('..', import.meta.url));

// The AI key belongs in the settings file, and only its owner should be able to read that file.
const { envFile } = cfg;
if (cfg.ai.apiKey && fs.existsSync(envFile) && (fs.statSync(envFile).mode & 0o077) !== 0) {
  console.warn(`Warning: ${envFile} holds your AI API key but other users can read it. Run: chmod 600 "${envFile}"`);
}

if (foldersOverlap(codeDir, cfg.home)) {
  console.error(
    `The Outpost code (${codeDir}) and the data folder (${cfg.home}) overlap, so downloads would land in the source tree.\n` +
      'Move the code to another folder (for example ~/Developer/outpost) or set OUTPOST_HOME in ~/.config/outpost/env.',
  );
  process.exit(1);
}

// The settings-file admin's name becomes a folder name (notes/<name>, chats/<name>), so it must be a plain name.
try {
  validName(cfg.user);
} catch {
  console.error(`OUTPOST_USER "${cfg.user}" isn't a valid name: use 1–32 letters a–z, digits, "-" or "_".`);
  process.exit(1);
}

// Off loopback, someone must sign in: a settings-file password or at least one account.
if (!LOOPBACK.has(cfg.host) && !cfg.pass && UserStore.count(cfg.home) === 0 && !cfg.allowOpen) {
  console.error(
    `Refusing to listen on ${cfg.host} without a password: anyone on the network could use your library, AI and files.\n` +
      'Set OUTPOST_PASSWORD (and optionally OUTPOST_USER), create an account on this Mac first, or bind to 127.0.0.1.\n' +
      '(Set OUTPOST_ALLOW_OPEN=1 only on a network you fully trust.)',
  );
  process.exit(1);
}

const { app, content, ctx } = await createApp(cfg);
const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Outpost listening on http://${cfg.host}:${cfg.port}  (data in ${cfg.home})`);
});
// Books, Education and apps on their own port, so their pages can't act as Outpost.
const contentServer = content.listen(cfg.content.port, cfg.host, () => {
  console.log(`Content (books, Education, apps) on http://${cfg.host}:${cfg.content.port}`);
});

// When shared, also serve HTTPS with Outpost's own certificate: phones' browsers only share GPS over HTTPS.
let secure: https.Server | null = null;
let secureContent: https.Server | null = null;
if (cfg.https.on) {
  try {
    const creds = await ctx.tls.ensure();
    secure = https.createServer(creds, app).listen(cfg.https.port, cfg.host, () => {
      console.log(`Outpost listening on https://${cfg.host}:${cfg.https.port}  (phones: open /join to set it up)`);
    });
    secureContent = https.createServer(creds, content).listen(cfg.content.httpsPort, cfg.host);
    const live = [secure, secureContent];
    ctx.tls.watch((next) => live.forEach((srv) => srv.setSecureContext(next)));
  } catch (e) {
    console.error('HTTPS is off: could not make a certificate.', e);
  }
}

/** Stops everything and exits; a non-zero code makes launchd start Outpost again (a restart). */
async function shutdown(code = 0): Promise<void> {
  server.close();
  secure?.close();
  contentServer.close();
  secureContent?.close();
  // Stop children without forgetting that Kolibri and apps were on, so it comes back next launch.
  await Promise.all([ctx.kiwix.stop(), ctx.kolibri.stop(false), ctx.apps.stopAll(), ctx.routing.stopAll(), ctx.awake.set(false, false)]);
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGHUP', () => shutdown(75));
