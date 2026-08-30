// Trascrizione vocale con provider pluggabile.
// Provider "whisper": binario whisper.cpp/faster-whisper locale configurato in
// config/platform.json (serve anche ffmpeg per convertire l'audio del browser in wav).
// Se non disponibile, il client usa la Web Speech API come fallback.
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJson, CONFIG_DIR } from './store.js';

function config() {
  return readJson(join(CONFIG_DIR, 'platform.json'), {})?.transcription ?? {};
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(0, 500) || `${cmd} exit ${code}`))));
  });
}

async function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes('/')) return existsSync(bin);
  try {
    await run('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

// Stato del provider: il client lo interroga per decidere se registrare audio
// (server-side) o usare la Web Speech API (client-side).
export async function transcriptionStatus() {
  const cfg = config();
  if (cfg.provider === 'off') return { available: false, provider: 'off' };
  const whisperOk = await binAvailable(cfg.whisperBin);
  const ffmpegOk = await binAvailable(cfg.ffmpegBin || 'ffmpeg');
  if (whisperOk && ffmpegOk) return { available: true, provider: 'whisper' };
  return { available: false, provider: 'webspeech', reason: whisperOk ? 'ffmpeg mancante' : 'binario whisper non configurato o mancante' };
}

export async function transcribe(audioBuffer, mime = 'audio/webm') {
  const cfg = config();
  const status = await transcriptionStatus();
  if (!status.available) {
    const err = new Error('trascrizione server non disponibile: usa il fallback Web Speech');
    err.code = 'NO_PROVIDER';
    throw err;
  }
  const dir = mkdtempSync(join(tmpdir(), 'transcribe-'));
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
  const src = join(dir, `input.${ext}`);
  const wav = join(dir, 'input.wav');
  try {
    writeFileSync(src, audioBuffer);
    await run(cfg.ffmpegBin || 'ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-f', 'wav', wav]);
    // Interfaccia whisper.cpp: -m modello -f file -otxt -of output. Con altri binari
    // compatibili (faster-whisper-cli) adeguare qui.
    const outBase = join(dir, 'out');
    const args = ['-f', wav, '-otxt', '-of', outBase, '-l', cfg.language || 'it'];
    if (cfg.whisperModel) args.unshift('-m', cfg.whisperModel);
    await run(cfg.whisperBin, args);
    const txtFile = `${outBase}.txt`;
    const text = existsSync(txtFile) ? readFileSync(txtFile, 'utf8').trim() : '';
    if (!text) throw new Error('trascrizione vuota');
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
