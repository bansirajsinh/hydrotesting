const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const { connectDatabase, closeDatabase } = require('./db');
const app = require('./app');

let server;
let liveWorker;

function startLiveWorker() {
  const workerScript = path.resolve(config.root, 'cv_worker/live_server.py');
  try {
    liveWorker = spawn(config.pythonExecutable, [workerScript], {
      cwd: config.root,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    liveWorker.on('error', (err) => console.warn(`Live worker notice: ${err.message}`));
    liveWorker.on('exit', (code) => {
      if (code !== 0 && code !== null) console.log(`Live camera Python worker exited with code ${code}`);
    });
  } catch (err) {
    console.warn(`Could not spawn live worker: ${err.message}`);
  }
}

(async () => {
  try {
    await connectDatabase();
    startLiveWorker();
    server = app.listen(config.port, config.host, () => console.log(`Hydrotest Studio running at http://${config.host}:${config.port}`));
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exitCode = 1;
  }
})();

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);
  if (liveWorker) {
    try { liveWorker.kill(); } catch {}
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
