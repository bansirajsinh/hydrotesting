const config = require('./config');
const { connectDatabase, closeDatabase } = require('./db');
const cameraManager = require('./camera-manager');
const app = require('./app');

let server;
(async () => {
  try {
    await connectDatabase();
    server = app.listen(config.port, config.host, () => console.log(`FuelFlux CNG Verification running at http://${config.host}:${config.port}`));
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exitCode = 1;
  }
})();
async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);
  if (server) await new Promise((resolve) => server.close(resolve));
  await cameraManager.stopAll();
  await closeDatabase();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
