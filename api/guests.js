// api/guests.js
// Vercel Serverless Function — baca & tulis daftar tamu (nama, no. WA, status kirim)
// ke tab terpisah di Google Spreadsheet YANG SAMA dengan RSVP (pakai service account
// yang sama, tidak perlu setup akun Google baru).
//
// ENV VARS: pakai yang SUDAH ADA dari api/rsvp.js (tidak perlu tambahan apa pun):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID
// Opsional:
//   GOOGLE_GUESTS_SHEET_NAME  -> nama tab, default "DaftarTamu"
//
// Tab-nya (dan baris header-nya) dibuat OTOMATIS kalau belum ada di spreadsheet,
// jadi tidak ada langkah manual tambahan di Google Sheets.
//
// Endpoint ini dilindungi kode akses yang sama dengan /api/kelola-tamu (cookie
// zb_admin_auth) -- orang lain tidak bisa baca/ubah data tamu lewat sini tanpa
// login lewat halaman itu dulu.

const { google } = require('googleapis');
const crypto = require('crypto');

const SHEET_NAME = process.env.GOOGLE_GUESTS_SHEET_NAME || 'DaftarTamu';
const HEADER = ['Nama', 'No. WA', 'Status', 'Ditambahkan'];
const COOKIE_NAME = 'zb_admin_auth';

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function computeToken(pin) {
  return crypto.createHmac('sha256', pin).update('zb-admin-session-v1').digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
  const pin = process.env.ADMIN_PIN;
  if (!pin) return false;
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  return safeEqual(token, computeToken(pin));
}

function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

// Cache di level module: bertahan selama container serverless-nya masih "hangat"
// (dipakai ulang untuk request berikutnya), supaya tidak cek ulang tiap request.
// Aman kalau reset ke false di cold start -- paling cuma satu kali cek ekstra.
let sheetEnsuredCache = false;

async function ensureSheetExists(sheets, spreadsheetId) {
  if (sheetEnsuredCache) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === SHEET_NAME
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  }
  sheetEnsuredCache = true;
}

module.exports = async function handler(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'Belum login. Buka /api/kelola-tamu dulu.' });
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Konfigurasi Google Sheets belum lengkap di environment variables.' });
  }

  let sheets;
  try {
    sheets = getSheetsClient();
  } catch (err) {
    console.error('Guests API auth error:', err);
    return res.status(500).json({ error: 'Gagal autentikasi ke Google Sheets.' });
  }

  try {
    await ensureSheetExists(sheets, sheetId);

    if (req.method === 'GET') {
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${SHEET_NAME}!A2:D`,
      });
      const rows = result.data.values || [];
      const guests = rows
        .filter((r) => r[0] && r[0].trim())
        .map((r) => ({
          nama: r[0] || '',
          telepon: r[1] || '',
          sent: (r[2] || '').toLowerCase() === 'terkirim',
          ditambahkan: r[3] || '',
        }));
      return res.status(200).json(guests);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const list = Array.isArray(body.guests) ? body.guests : [];

      const today = new Date().toISOString().slice(0, 10);
      const cleaned = list
        .map((g) => ({
          nama: (g.nama || '').toString().trim().slice(0, 120),
          telepon: (g.telepon || '').toString().trim().slice(0, 20),
          sent: !!g.sent,
          ditambahkan: (g.ditambahkan || '').toString().slice(0, 40) || today,
        }))
        .filter((g) => g.nama);

      // Model penyimpanannya sengaja "timpa semua": lebih sederhana & aman dari
      // masalah penomoran baris dibanding update/hapus baris satu-satu.
      // Catatan: kalau dua orang menyimpan nyaris bersamaan dari perangkat
      // berbeda, yang tersimpan paling akhir yang menang.
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: `${SHEET_NAME}!A2:D`,
      });

      if (cleaned.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `${SHEET_NAME}!A2:D${cleaned.length + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: cleaned.map((g) => [g.nama, g.telepon, g.sent ? 'Terkirim' : 'Belum', g.ditambahkan]),
          },
        });
      }

      return res.status(200).json({ ok: true, count: cleaned.length });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} tidak didukung.` });
  } catch (err) {
    console.error('Guests API error:', err);
    return res.status(500).json({ error: 'Gagal memproses data tamu di spreadsheet.' });
  }
};
