// api/rsvp.js
// Vercel Serverless Function — baca & tulis data RSVP ke Google Spreadsheet
// lewat Google Service Account. Kontrak API-nya (GET -> array, POST -> {name,status,message})
// sudah sesuai dengan yang dipanggil dari invite.html, jadi tidak perlu ubah apa pun di frontend.
//
// ENV VARS yang wajib diisi di Vercel (Project Settings -> Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  -> email service account (...@....iam.gserviceaccount.com)
//   GOOGLE_PRIVATE_KEY            -> private key dari file JSON service account
//                                    (paste apa adanya, termasuk baris
//                                    "-----BEGIN PRIVATE KEY-----" ... "-----END PRIVATE KEY-----")
//   GOOGLE_SHEET_ID               -> ID spreadsheet (bagian di URL sheet antara /d/ dan /edit)
//   GOOGLE_SHEET_NAME             -> (opsional) nama tab, default "RSVP"
//
// Sheet-nya wajib di-share ke email service account di atas sebagai Editor.
// Baris pertama (header, baris 1) harus persis empat kolom ini:
//   Timestamp | Nama | Status | Ucapan

const { google } = require('googleapis');

const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'RSVP';
const RANGE_READ = `${SHEET_NAME}!A2:D`;
const RANGE_APPEND = `${SHEET_NAME}!A:D`;
const VALID_STATUS = ['hadir', 'tidak', 'ragu'];

function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

module.exports = async function handler(req, res) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Konfigurasi Google Sheets belum lengkap di environment variables.' });
  }

  let sheets;
  try {
    sheets = getSheetsClient();
  } catch (err) {
    console.error('RSVP API auth error:', err);
    return res.status(500).json({ error: 'Gagal autentikasi ke Google Sheets.' });
  }

  try {
    if (req.method === 'GET') {
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: RANGE_READ,
      });
      const rows = result.data.values || [];
      const wishes = rows
        .filter((r) => (r[1] && r[1].trim()) || (r[3] && r[3].trim()))
        .map((r) => ({
          name: r[1] || '',
          status: VALID_STATUS.includes(r[2]) ? r[2] : 'ragu',
          message: r[3] || '',
        }));
      return res.status(200).json(wishes);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const name = (body.name || '').toString().trim().slice(0, 120);
      const status = VALID_STATUS.includes(body.status) ? body.status : 'ragu';
      const message = (body.message || '').toString().trim().slice(0, 1000);

      if (!name || !message) {
        return res.status(400).json({ error: 'Nama dan ucapan wajib diisi.' });
      }

      const timestamp = new Date().toISOString();
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: RANGE_APPEND,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[timestamp, name, status, message]] },
      });

      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} tidak didukung.` });
  } catch (err) {
    console.error('RSVP API error:', err);
    return res.status(500).json({ error: 'Gagal memproses data RSVP.' });
  }
};
