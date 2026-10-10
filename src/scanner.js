const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');

const MAX_STDOUT_BYTES = 5_000_000;
const MAX_STDERR_BYTES = 1_000_000;

function parseWorkerJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Model/runtime libraries may print diagnostics. Continue to the last JSON line.
    }
  }
  return null;
}

function safeWorkerError(parsed, stderr, code) {
  const workerMessage = parsed && (
    parsed.error || parsed.message || parsed.detail || parsed.reason
  );
  const diagnostics = String(stderr || '').trim().slice(-2500);
  const parts = [];

  if (workerMessage) parts.push(String(workerMessage));
  if (parsed && parsed.status) parts.push(`Worker status: ${parsed.status}`);
  if (diagnostics && !parts.some((part) => part.includes(diagnostics))) parts.push(diagnostics);
  if (!parts.length) parts.push(`The Python scanner exited with code ${code} and returned no diagnostic JSON.`);
  return parts.join(' | ');
}

function runScan(filePath, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    if (!filePath || !fs.existsSync(filePath)) {
      reject(new Error('Uploaded media file is not present on the server.'));
      return;
    }

    const absolutePath = path.resolve(filePath);
    const args = [config.workerScript, '--input', absolutePath, '--json'];
    let child;
    try {
      child = spawn(config.pythonExecutable, args, {
        cwd: config.root,
        windowsHide: true,
        shell: false,
        env: { ...process.env },
      });
    } catch (err) {
      reject(new Error(`Cannot start Python scanner: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let outputOverflow = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      finish(reject, new Error(
        'Plate scan timed out. Try a shorter video, reduce VIDEO_SAMPLE_FPS/MAX_VIDEO_FRAMES, or increase the worker timeout.'
      ));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        outputOverflow = true;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, 'utf8') > MAX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_BYTES);
      }
    });

    child.on('error', (err) => {
      finish(reject, new Error(
        `Cannot start Python scanner using '${config.pythonExecutable}': ${err.message}. ` +
        'Set PYTHON_EXECUTABLE to the Python interpreter where cv_worker/requirements.txt is installed.'
      ));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (outputOverflow) {
        finish(reject, new Error('Scanner output exceeded the safety limit. Check the configured worker and OCR model logs.'));
        return;
      }

      const parsed = parseWorkerJson(stdout);
      if (code !== 0) {
        // scan_media.py returns structured JSON even for initialization errors.
        // Parse that JSON before rejecting so users see the real missing model/dependency.
        finish(reject, new Error(
          `Plate scanner failed (exit code ${code}${signal ? `, signal ${signal}` : ''}): ` +
          safeWorkerError(parsed, stderr, code)
        ));
        return;
      }

      if (!parsed) {
        const diagnostics = String(stderr || '').trim().slice(-1000);
        finish(reject, new Error(
          `Scanner finished but returned no parseable JSON result.${diagnostics ? ` ${diagnostics}` : ''}`
        ));
        return;
      }

      if (['INIT_ERROR', 'ERROR'].includes(parsed.status) && parsed.error) {
        finish(reject, new Error(String(parsed.error)));
        return;
      }

      finish(resolve, parsed);
    });
  });
}

module.exports = { runScan, parseWorkerJson, safeWorkerError };
