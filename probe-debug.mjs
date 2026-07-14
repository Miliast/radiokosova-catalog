#!/usr/bin/env node
/**
 * Verbose single-stream probe — shows exactly what the server answers, so a
 * wrongly-flagged station can be diagnosed in seconds.
 *
 *   node probe-debug.mjs <stream-url>
 *   node probe-debug.mjs radiovizioni      (id from stations.json works too)
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let target = process.argv[2];
if (!target) {
  console.error('Usage: node probe-debug.mjs <stream-url | station-id>');
  process.exit(1);
}
if (!target.includes('://')) {
  const { stations } = JSON.parse(readFileSync(path.join(ROOT, 'stations.json'), 'utf8'));
  const st = stations.find((s) => s.id === target);
  if (!st) {
    console.error(`Station id "${target}" not in stations.json`);
    process.exit(1);
  }
  target = st.streamUrl;
  console.log(`Station ${process.argv[2]} → ${target}`);
}

function probeVerbose(url, label) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    const t0 = Date.now();
    let settled = false;
    const done = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      console.log(`  → ${msg} (${Date.now() - t0} ms)\n`);
      resolve();
    };
    console.log(`[${label}] ${u.hostname}:${port}${u.pathname}${u.search}`);
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false })
      : net.connect({ host: u.hostname, port });
    const timer = setTimeout(() => done('TIMEOUT nach 10 s ohne verwertbare Antwort'), 10_000);
    socket.on('error', (e) => done(`SOCKET-FEHLER: ${e.message}`));
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      console.log(`  verbunden nach ${Date.now() - t0} ms`);
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
          `User-Agent: AppleCoreMedia/1.0.0 (iPhone; U; CPU OS 18_0 like Mac OS X)\r\n` +
          `Icy-MetaData: 0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = '';
    let headersShown = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      if (!settled && !headersShown) {
        headersShown = true;
        console.log('  --- Antwort-Header ---');
        console.log(
          buf
            .slice(0, headerEnd)
            .split('\r\n')
            .map((l) => `  ${l}`)
            .join('\n'),
        );
      }
      const bodyBytes = buf.length - headerEnd - 4;
      if (bodyBytes > 0) done(`ONLINE — ${bodyBytes} Body-Bytes empfangen`);
    });
    socket.on('close', () => done('Verbindung geschlossen ohne Body-Bytes'));
  });
}

await probeVerbose(target, 'probe');
