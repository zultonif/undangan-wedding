/**
 * Vercel Serverless Function — RSVP ke Google Sheets (tanpa Apps Script).
 *
 * File ini berjalan di server Vercel, TIDAK dikirim ke browser tamu.
 * Kredensial Google disimpan sebagai Environment Variable di dashboard Vercel,
 * jadi tidak pernah terlihat lewat "view source" atau devtools.
 *
 * Env var yang dibutuhkan (diisi di Vercel > Project Settings > Environment Variables):
 *   GOOGLE_CLIENT_EMAIL  -> dari file JSON service account (field "client_email")
 *   GOOGLE_PRIVATE_KEY   -> dari file JSON service account (field "private_key")
 *   GOOGLE_SHEET_ID      -> ID sheet, ambil dari URL:
 *                           https://docs.google.com/spreadsheets/d/ID_INI/edit
 *
 * Sheet harus punya tab bernama "RSVP" dengan header baris pertama:
 *   Timestamp | Nama | Status | Pesan
 * dan sheet itu harus di-Share (akses Editor) ke alamat GOOGLE_CLIENT_EMAIL.
 */

const { google } = require('googleapis');

const SHEET_RANGE = 'RSVP!A:D';

function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

module.exports = async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    if (req.method === 'GET') {
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: SHEET_RANGE
      });
      const rows = (result.data.values || []).slice(1); // buang baris header
      const data = rows
        .filter(r => r[1])
        .map(r => ({
          name: String(r[1] || ''),
          status: String(r[2] || 'ragu'),
          message: String(r[3] || '')
        }));
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      const name = (body && body.name || '').toString().trim();
      const status = (body && body.status || 'ragu').toString().trim();
      const message = (body && body.message || '').toString().trim();

      if (!name || !message) {
        return res.status(400).json({ error: 'Nama dan pesan wajib diisi.' });
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: SHEET_RANGE,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[new Date().toISOString(), name, status, message]] }
      });
      return res.status(200).json({ result: 'success' });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('RSVP API error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
};
