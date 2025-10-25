// tcp-server.js
const net = require('net');
const express = require('express');
const path = require('path');

// ====== PostgreSQL ======
const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'EKMCydhu1355',   // <-- ajusta si cambió
  port: 5432,
});

// Inserta 1 fila cuando hay FIX
async function guardarEnDB(imei, lat, lon, tsMs) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  try {
    await pool.query(
      `INSERT INTO posiciones (imei, latitud, longitud, "timestamp")
       VALUES ($1, $2, $3, to_timestamp($4/1000.0))`,
      [imei, lat, lon, tsMs]
    );
  } catch (e) {
    console.error('DB error:', e.message);
  }
}

/**
 * Estado en memoria por IMEI:
 * {
 *   estado: 'conectando' | 'conectado',
 *   fix: boolean,
 *   sats: number,
 *   last: { lat, lon } | null,
 *   lastTs: number | null
 * }
 */
const estadoPorImei = new Map();

// ---------- Helpers de parsing (Codec 8) ----------
function readInt64MsBE(buf, off) {
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return Number((BigInt(hi) << 32n) | BigInt(lo));
}

function parseRecordCodec8(buf, off) {
  let o = off;
  const ts = readInt64MsBE(buf, o); o += 8;
  o += 1; // priority

  const lonRaw = buf.readInt32BE(o); o += 4;
  const latRaw = buf.readInt32BE(o); o += 4;
  o += 2; // altitude
  o += 2; // angle
  const sats = buf.readUInt8(o); o += 1; // satélites en uso
  o += 2; // speed

  const lon = lonRaw / 1e7;
  const lat = latRaw / 1e7;

  // IO (solo lo saltamos bien)
  o += 1; // eventId
  o += 1; // totalIO (no usado)

  let n1 = buf.readUInt8(o); o += 1; for (let i = 0; i < n1; i++) o += 1 + 1;
  let n2 = buf.readUInt8(o); o += 1; for (let i = 0; i < n2; i++) o += 1 + 2;
  let n4 = buf.readUInt8(o); o += 1; for (let i = 0; i < n4; i++) o += 1 + 4;
  let n8 = buf.readUInt8(o); o += 1; for (let i = 0; i < n8; i++) o += 1 + 8;

  return { lat, lon, sats, ts, nextOffset: o };
}

function decodeCodec8(dataBlock) {
  let o = 0;
  const codecId = dataBlock.readUInt8(o); o += 1; // 0x08 esperado
  const nHeader = dataBlock.readUInt8(o); o += 1;

  const records = [];
  for (let i = 0; i < nHeader; i++) {
    const r = parseRecordCodec8(dataBlock, o);
    records.push(r);
    o = r.nextOffset;
  }
  const nTail = dataBlock.readUInt8(o);
  return { codecId, nHeader, nTail, records };
}

// ---------- Servidor TCP (Teltonika) ----------
const TCP_PORT = 3001;

const tcpServer = net.createServer((socket) => {
  console.log('📡 Conexión entrante');
  let imei = null;
  let buf = Buffer.alloc(0);

  // Mantener viva la conexión
  socket.setKeepAlive(true, 15000);

  socket.on('data', async (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    // 1) Handshake IMEI
    if (!imei) {
      if (buf.length < 2) return;
      const imeiLen = buf.readUInt16BE(0);
      if (buf.length < 2 + imeiLen) return;

      imei = buf.slice(2, 2 + imeiLen).toString('ascii');
      console.log('🔑 IMEI:', imei);

      // Estado inicial: conectando (sin FIX)
      estadoPorImei.set(imei, {
          estado: 'conectando',
          fix: false,
          sats: 0,
          last: null,
          lastTs: null,
          online: true,        
          lastSeen: Date.now(),

      });
      console.log(`🟡 ${imei}: conectando (sin FIX)`);

      // ACK IMEI
      socket.write(Buffer.from([0x01]));
      buf = buf.slice(2 + imeiLen);
    }

    // 2) Frames AVL
    while (buf.length >= 12) {
      // Marcar último visto y online
      const cur = estadoPorImei.get(imei);
      if (cur) {
        cur.online = true;
        cur.lastSeen = Date.now();
        estadoPorImei.set(imei, cur);
      }
     
      // buscar preámbulo 0x00000000
      const pre = buf.indexOf(Buffer.from([0, 0, 0, 0]));
      if (pre === -1) { if (buf.length > 3) buf = buf.slice(-3); return; }
      if (pre > 0) { buf = buf.slice(pre); if (buf.length < 12) return; }

      const dataLen = buf.readUInt32BE(4);
      const total = 12 + dataLen; // 4 pre + 4 len + data + 4 crc
      if (buf.length < total) return;

      const dataBlock = buf.slice(8, 8 + dataLen);
      const codecId = dataBlock.readUInt8(0);
      const nHeader = dataBlock.readUInt8(1);
      const nTail = dataBlock.readUInt8(dataBlock.length - 1);
      console.log('🎯 codecId =', codecId, 'N(h)=', nHeader, 'N(t)=', nTail);

      let lastSats = 0;
      let gotFix = false;
      let lastFixCoord = null;
      let lastFixTs = null;

      try {
        if (codecId === 0x08) {
          const d = decodeCodec8(dataBlock);
          console.log(`📦 AVL len=${dataLen}, decod=${d.records.length}`);

          for (const r of d.records) {
            lastSats = r.sats;
            const hasFix = r.sats > 0;
            if (hasFix && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
              gotFix = true;
              lastFixCoord = { lat: r.lat, lon: r.lon };
              lastFixTs = r.ts;

              // 👇 Guardar en Postgres
              guardarEnDB(imei, r.lat, r.lon, r.ts);

              console.log(`🟢 ${imei}: FIX sats=${r.sats} lat=${r.lat.toFixed(6)} lon=${r.lon.toFixed(6)} ts=${new Date(r.ts).toISOString()}`);
            }
          }
        } else {
          console.log('⚠️ No es Codec 8 (probable 8E/142). En el Configurator, cambia Data Protocol → Codec 8.');
        }
      } catch (e) {
        console.error('❌ decode error:', e.message);
      }

      // Actualiza estado en memoria
      const prev = estadoPorImei.get(imei) || {
        estado: 'conectando', fix: false, sats: 0, last: null, lastTs: null
      };

      if (gotFix) {
        estadoPorImei.set(imei, {
          estado: 'conectado',
          fix: true,
          sats: lastSats,
          last: lastFixCoord,
          lastTs: lastFixTs
        });
        if (prev.estado !== 'conectado') {
          console.log(`✅ ${imei}: conectado (con FIX)`);
        }
      } else {
        estadoPorImei.set(imei, {
          ...prev,
          estado: 'conectando',
          fix: false,
          sats: lastSats
        });
        console.log(`🟡 ${imei}: conectando… (sats=${lastSats})`);
      }

      // ===== ACK OBLIGATORIO =====
      // Para que el FMC130 marque "Last Server Response Time" y no cierre,
      // responde SIEMPRE con el N del header (nHeader).
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(nHeader, 0);
      socket.write(ack);
      // ===========================

      // Consumir frame completo
      buf = buf.slice(total);
    }
  });

  // al final del createServer, junto a los otros eventos del socket:

socket.on('end', () => {
  const cur = estadoPorImei.get(imei);
  if (cur) {
    cur.online = false;
    estadoPorImei.set(imei, cur);
  }
  console.log('🔌 Conexión terminada');
});

socket.on('error', (e) => {
  const cur = estadoPorImei.get(imei);
  if (cur) {
    cur.online = false;
    estadoPorImei.set(imei, cur);
  }
  console.log('⚠️ Socket error:', e.message);
});

socket.on('close', () => {
  const cur = estadoPorImei.get(imei);
  if (cur) {
    cur.online = false;
    estadoPorImei.set(imei, cur);
  }
  console.log('🧹 Conexión cerrada');
});

});

tcpServer.listen(TCP_PORT, () => {
  console.log('🚀 TCP escuchando en puerto', TCP_PORT);
});

// ---------- API HTTP y estáticos ----------
const app = express();
const HTTP_PORT = 8080;

// Sirve la carpeta /Public (para acceder a tus HTML, CSS, JS en el navegador)
app.use(express.static(path.join(__dirname, 'Public')));

app.get('/status/:imei', (req, res) => {
  const imei = req.params.imei;
  const st = estadoPorImei.get(imei);
  if (!st) return res.status(404).json({ ok: false, error: 'IMEI no visto aún' });
  res.json({ ok: true, imei, ...st });
});

app.get('/latest', (_req, res) => {
  const all = [];
  for (const [imei, st] of estadoPorImei.entries()) {
    all.push({ imei, ...st });
  }
  res.json({ ok: true, dispositivos: all });
});
app.get('/devices', (_req, res) => {
  const items = [];
  for (const [imei, st] of estadoPorImei.entries()) {
    const { estado, fix, sats, last, lastTs, online, lastSeen } = st;
    items.push({ imei, estado, fix, sats, last, lastTs, online, lastSeen });
  }
  res.json({ ok: true, devices: items });
});

// DEVUELVE la lista de IMEIs con datos en la BD
app.get('/api/imeis', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT imei
      FROM public.posiciones
      ORDER BY imei
    `);
    res.json({ ok: true, imeis: rows.map(r => r.imei) });
  } catch (e) {
    console.error('DB error /api/imeis:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// DEVUELVE puntos históricos de un IMEI en un rango (ordenados por tiempo)
app.get('/api/history', async (req, res) => {
  try {
    const imei = String(req.query.imei || '').trim();
    if (!imei) return res.status(400).json({ ok: false, error: 'Falta imei' });

    // Rango por defecto: últimas 24h
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24*60*60*1000);
    const limit = Math.min(parseInt(req.query.limit || '20000', 10), 100000);

    if (isNaN(from.getTime()) || isNaN(to.getTime()))
      return res.status(400).json({ ok: false, error: 'Fecha inválida' });

    const { rows } = await pool.query(
      `SELECT imei,
              latitud  AS lat,
              longitud AS lon,
              "timestamp" AS ts
       FROM public.posiciones
       WHERE imei = $1
         AND "timestamp" BETWEEN $2 AND $3
       ORDER BY "timestamp" ASC
       LIMIT $4`,
      [imei, from, to, limit]
    );

    res.json({ ok: true, imei, from, to, count: rows.length, points: rows });
  } catch (e) {
    console.error('DB error /api/history:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.listen(HTTP_PORT, () => {
  console.log('🌐 HTTP escuchando en puerto', HTTP_PORT, '(GET /latest, /status/:imei)');
});
