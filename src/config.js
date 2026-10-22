require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function floatEnv(name, fallback, min, max) {
  const n = Number.parseFloat(process.env[name] || '');
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function resolvePython() {
  const custom = process.env.PYTHON_EXECUTABLE;
  if (custom) {
    const resolved = path.isAbsolute(custom) ? custom : path.resolve(root, custom);
    if (fs.existsSync(resolved)) return resolved;
  }
  const venvWin = path.resolve(root, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvWin)) return venvWin;
  const venvUnix = path.resolve(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venvUnix)) return venvUnix;
  return process.platform === 'win32' ? 'python' : 'python3';
}
module.exports = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 3000, 1, 65535),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGODB_DB_NAME || 'fuelflux_cng_demo',
  pythonExecutable: resolvePython(),
  workerScript: path.resolve(root, process.env.CV_WORKER_SCRIPT || 'cv_worker/scan_media.py'),
  uploadDir: path.resolve(root, 'storage/uploads'),
  cropDir: path.resolve(root, 'storage/crops'),
  suppliedMediaDir: path.resolve(root, 'data/supplied-media'),
  publicDir: path.resolve(root, 'public'),
  maxUploadMb: intEnv('MAX_UPLOAD_MB', 200, 1, 2048),
  maxVideoSeconds: intEnv('MAX_VIDEO_SECONDS', 120, 1, 3600),
  ocrMinConfidence: floatEnv('OCR_MIN_CONFIDENCE', 0.62, 0.1, 0.99),
  dueSoonDays: intEnv('DUE_SOON_DAYS', 30, 1, 365),
  demoMode: (process.env.DEMO_MODE || 'true').toLowerCase() === 'true',
  allowDemoSeed: (process.env.ALLOW_DEMO_SEED || 'true').toLowerCase() === 'true',
  allowDemoReset: (process.env.ALLOW_DEMO_RESET || 'false').toLowerCase() === 'true',
  cctvMaxConcurrent: intEnv('CCTV_MAX_CONCURRENT', 2, 1, 10),
  cctvSampleIntervalSeconds: floatEnv('CCTV_SAMPLE_INTERVAL_SECONDS', 1, 0.3, 30),
  cctvEventCooldownSeconds: intEnv('CCTV_EVENT_COOLDOWN_SECONDS', 20, 5, 600),
};
