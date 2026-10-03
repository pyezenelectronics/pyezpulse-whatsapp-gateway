// PyezPulse Cloud WhatsApp Gateway (Baileys Engine)
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let qrCodeBase64 = null;
let isConnected = false;
let clientStatus = 'Initializing...';
let connectedPhone = null;

// Daily Quota Tracking (In-memory & auto reset at midnight)
let dailyQuota = {
  date: new Date().toISOString().split('T')[0],
  limit: 100,
  sent: 0
};

function checkAndResetDailyQuota() {
  const today = new Date().toISOString().split('T')[0];
  if (dailyQuota.date !== today) {
    dailyQuota.date = today;
    dailyQuota.sent = 0;
    console.log(`[PyezPulse Gateway] Quota automatically reset for new day: ${today}`);
  }
}

async function startWhatsAppSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['PyezPulse Cloud', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeBase64 = await QRCode.toDataURL(qr);
          isConnected = false;
          clientStatus = 'Scan QR Code';
          console.log('[PyezPulse Gateway] Fresh QR code generated!');
        } catch (err) {
          console.error('[PyezPulse Gateway] QR code generation error:', err);
        }
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[PyezPulse Gateway] Connection closed (status: ${statusCode}), reconnecting:`, shouldReconnect);

        if (shouldReconnect) {
          clientStatus = 'Reconnecting...';
          setTimeout(startWhatsAppSocket, 3000);
        } else {
          clientStatus = 'Logged Out';
          qrCodeBase64 = null;
          connectedPhone = null;
          // Clear session files if logged out
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {}
        }
      } else if (connection === 'open') {
        isConnected = true;
        qrCodeBase64 = null;
        connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
        clientStatus = 'Connected';
        console.log(`[PyezPulse Gateway] 🚀 WhatsApp Connected successfully! Phone: ${connectedPhone}`);
      }
    });
  } catch (err) {
    console.error('[PyezPulse Gateway] Socket startup error:', err);
    setTimeout(startWhatsAppSocket, 5000);
  }
}

// 1. Health check & status
app.get('/', (req, res) => {
  checkAndResetDailyQuota();
  res.json({
    service: 'PyezPulse Cloud WhatsApp Gateway',
    version: '1.0.0',
    status: clientStatus,
    ready: isConnected,
    phone: connectedPhone,
    daily_sent: dailyQuota.sent,
    daily_limit: dailyQuota.limit,
    daily_remaining: Math.max(0, dailyQuota.limit - dailyQuota.sent)
  });
});

// 2. Status & QR endpoint
app.get('/api/status', (req, res) => {
  checkAndResetDailyQuota();
  res.json({
    engine: 'Baileys',
    ready: isConnected,
    status: clientStatus,
    phone: connectedPhone,
    qrImage: qrCodeBase64,
    daily_sent: dailyQuota.sent,
    daily_limit: dailyQuota.limit,
    daily_remaining: Math.max(0, dailyQuota.limit - dailyQuota.sent)
  });
});

// 3. Clear session / Logout endpoint
app.post('/api/logout', (req, res) => {
  try {
    if (sock) {
      try { sock.logout(); } catch (e) {}
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    isConnected = false;
    connectedPhone = null;
    clientStatus = 'Logged Out';
    qrCodeBase64 = null;
    setTimeout(startWhatsAppSocket, 1000);
    return res.json({ success: true, message: 'Logged out successfully. New QR will be generated.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Send Message Endpoint (100 msgs/day enforced)
app.post('/api/send', async (req, res) => {
  checkAndResetDailyQuota();

  if (dailyQuota.sent >= dailyQuota.limit) {
    return res.status(429).json({
      success: false,
      error: `Daily limit of ${dailyQuota.limit} messages reached! It resets automatically tomorrow.`
    });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not connected. Please scan the QR code first.'
    });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Phone and message required.' });
  }

  try {
    const cleanNumber = phone.replace(/[^\d]/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    console.log(`[PyezPulse Gateway] Sending to ${jid}...`);
    const result = await sock.sendMessage(jid, { text: message });

    dailyQuota.sent += 1;

    console.log(`[PyezPulse Gateway] Delivered to ${cleanNumber}! (${dailyQuota.sent}/${dailyQuota.limit} today)`);

    return res.json({
      success: true,
      messageId: result?.key?.id || 'delivered',
      daily_sent: dailyQuota.sent,
      daily_limit: dailyQuota.limit,
      daily_remaining: Math.max(0, dailyQuota.limit - dailyQuota.sent)
    });
  } catch (err) {
    console.error(`[PyezPulse Gateway] Error sending message:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start listener and WhatsApp engine
app.listen(PORT, () => {
  console.log(`[PyezPulse Gateway] Server listening on port ${PORT}`);
  startWhatsAppSocket();
});
