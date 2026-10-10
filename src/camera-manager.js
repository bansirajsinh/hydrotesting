const { spawn } = require('node:child_process');
const readline = require('node:readline');
const config = require('./config');
const running = new Map();

function testStream(streamUrl, cameraId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonExecutable, [config.workerScript, '--test-stream'], { cwd: config.root, windowsHide: true, shell: false, env: { ...process.env } });
    let output = ''; let stderr = ''; let finished = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); if (!finished) { finished = true; reject(new Error('Camera test timed out.')); } }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (e) => { if (!finished) { finished = true; clearTimeout(timer); reject(e); } });
    child.on('close', (code) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const line = output.split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return reject(new Error(stderr.slice(-1000) || `Camera test exited with code ${code}`));
      try { resolve(JSON.parse(line)); } catch { reject(new Error('Camera test returned an invalid response.')); }
    });
    child.stdin.write(`${JSON.stringify({ streamUrl, cameraId, sampleIntervalSeconds: config.cctvSampleIntervalSeconds })}\n`);
    child.stdin.end();
  });
}

function startCamera(camera, onEvent) {
  if (running.has(String(camera._id))) return { ok: false, message: 'Camera monitoring is already running.' };
  if (running.size >= config.cctvMaxConcurrent) return { ok: false, message: 'Maximum concurrent CCTV streams reached.' };
  const child = spawn(config.pythonExecutable, [config.workerScript, '--stream'], { cwd: config.root, windowsHide: true, shell: false, env: { ...process.env } });
  const id = String(camera._id);
  const entry = { child, startedAt: new Date(), lastEventAt: null, status: 'CONNECTING', lastError: null };
  running.set(id, entry);
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      const data = JSON.parse(line);
      if (data.type === 'status') { entry.status = data.status || entry.status; entry.lastError = data.message || null; }
      if (data.type === 'plate_event') {
        entry.lastEventAt = new Date();
        Promise.resolve(onEvent(camera, data)).catch((err) => { entry.lastError = err.message; });
      }
    } catch { /* ignore non-JSON diagnostics; detailed stderr stays server-side */ }
  });
  child.stderr.on('data', (chunk) => { entry.lastError = chunk.toString().slice(-1000); });
  child.on('error', (err) => { entry.status = 'ERROR'; entry.lastError = err.message; running.delete(id); });
  child.on('close', (code) => { entry.status = code === 0 ? 'STOPPED' : 'ERROR'; if (code !== 0 && !entry.lastError) entry.lastError = `Worker ended with code ${code}`; running.delete(id); });
  child.stdin.write(`${JSON.stringify({ streamUrl: camera.streamUrl, cameraId: id, stationId: camera.stationId, sampleIntervalSeconds: config.cctvSampleIntervalSeconds, eventCooldownSeconds: config.cctvEventCooldownSeconds })}\n`);
  return { ok: true, status: entry.status };
}
function stopCamera(id) {
  const entry = running.get(String(id));
  if (!entry) return { ok: false, message: 'Camera is not being monitored.' };
  entry.child.kill('SIGTERM');
  entry.status = 'STOPPING';
  return { ok: true, status: entry.status };
}
function getCameraState(id) {
  const item = running.get(String(id));
  if (!item) return { running: false, status: 'STOPPED' };
  return { running: true, status: item.status, startedAt: item.startedAt, lastEventAt: item.lastEventAt, lastError: item.lastError };
}
function listCameraStates() {
  return [...running.entries()].map(([id, item]) => ({ id, running: true, status: item.status, startedAt: item.startedAt, lastEventAt: item.lastEventAt, lastError: item.lastError }));
}
async function stopAll() {
  for (const item of running.values()) item.child.kill('SIGTERM');
  running.clear();
}
module.exports = { testStream, startCamera, stopCamera, getCameraState, listCameraStates, stopAll };
