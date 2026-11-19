// Entrypoint: boot the forge, announce it to the trial environment, and
// stay alive until the environment reports the trial is finished.
//
// The trial harness (see RULES.txt, "The lifecycle") drives this program in
// four phases:
//
//   1. MAKEFUN_ENV_URL points at the environment (for example
//      http://store:8080 inside a trial pod). With no such URL there is
//      nothing to talk to, so the process gives up at once.
//   2. The forge listens on an ephemeral port chosen by the kernel
//      (listen(0)). Port 8080 belongs to the environment and is never
//      bound here.
//   3. The program POSTs {"port": N} to $MAKEFUN_ENV_URL/register. The
//      environment remembers where the request came from plus N and dials
//      that address from then on. Whoever registers first wins: a 409
//      means some other entry already won, which this process accepts
//      and waits through like any other outcome.
//   4. The program polls GET $MAKEFUN_ENV_URL/done. The environment
//      answers {"done": false} while the suite is still running and
//      {"done": true} once it has finished and written its export; on
//      that answer the program shuts the server down and exits 0.
//
// A program that exits, crashes, or never registers before the boot
// budget ends leaves no working forge and scores 0, so this file never
// exits early: a failed or slow request is retried with a short
// exponential backoff. Only a contract error (400 or 405 from register)
// ends the program, and only the environment saying done ends the wait.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no environment to register with\n');
  process.exit(1);
}

/** Longest a single register or done request may run before it is dropped. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const RETRY_FIRST_MS = 250;
const RETRY_LIMIT_MS = 2_000;

/** Pause for `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after the `attempt`-th failed request: doubles from RETRY_FIRST_MS, capped. */
function pauseAfter(attempt: number): number {
  return Math.min(RETRY_LIMIT_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the environment takes it. 200 is the normal
 * answer; 409 means a first register already won, which is not this
 * process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or any other status is retried, since the environment
 * may still be starting up.
 */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(pauseAfter(attempt));
  }
}

/** GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the request timed out:
      // it is not done, so poll again.
    }
    await pause(pauseAfter(attempt));
  }
}

/** Bind a port, announce it, then wait for the environment to say done. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announce(address.port);
  process.stdout.write('[entry] announced; waiting for the environment to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
