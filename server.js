require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');
const os = require('os'); // Imported to find your Network IP

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const IPFS_API = process.env.IPFS_API || 'http://127.0.0.1:5001/api/v0/add';

// --- DATABASE CONNECTION (Smart Switch) ---
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    // Uses .env password if available, otherwise empty (for Windows)
    password: process.env.DB_PASS || '', 
    database: process.env.DB_NAME || 'credential_db'
};

const pool = mysql.createPool(dbConfig);

// --- HELPER: FIND REAL NETWORK IP ---
function getServerIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const SERVER_IP = getServerIP();
console.log(`🌍 Server Network IP: ${SERVER_IP}`);

// --- HELPER: GENERATE & STORE ---
async function generateAndStore(studentID, studentName, course, date) {
    console.log(`Processing: ${studentName}`);

    // A. Generate PDF
    const doc = new PDFDocument();
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    
    doc.fontSize(25).text('CERTIFICATE OF COMPLETION', 100, 100);
    doc.fontSize(18).text(`Awarded to: ${studentName}`);
    doc.text(`ID: ${studentID}`);
    doc.text(`Course: ${course}`);
    doc.text(`Date: ${date}`);
    doc.end();

    await new Promise(resolve => doc.on('end', resolve));
    const pdfBuffer = Buffer.concat(buffers);

    // B. Upload to IPFS
    const form = new FormData();
    form.append('file', pdfBuffer, { filename: `${studentID}.pdf` });
    const ipfsRes = await axios.post(IPFS_API, form, { headers: { ...form.getHeaders() } });
    const hash = ipfsRes.data.Hash;

    // C. Save to MySQL
    const sql = `INSERT INTO credentials (student_id, student_name, course, ipfs_hash, pdf_file) VALUES (?, ?, ?, ?, ?)`;
    await pool.execute(sql, [studentID, studentName, course, hash, pdfBuffer]);

    return hash;
}

// --- ENDPOINT 1: ISSUE CREDENTIAL ---
app.post('/api/issue', async (req, res) => {
    try {
        const { studentID, studentName, course, date } = req.body;
        const hash = await generateAndStore(studentID, studentName, course, date);

        res.json({
            status: "Success",
            ipfs_hash: hash,
            // Now providing BOTH links
            urls: {
                public: `https://ipfs.io/ipfs/${hash}`,              // Slow, Universal
                local:  `http://${SERVER_IP}:8080/ipfs/${hash}`      // Instant, WiFi-only
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT 2: VERIFY CREDENTIAL ---
app.get('/api/verify/:studentID', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT student_name, course, ipfs_hash FROM credentials WHERE student_id = ?', [req.params.studentID]);
        
        if (rows.length === 0) return res.status(404).json({ valid: false });

        res.json({
            valid: true,
            data: rows[0],
            // Now providing BOTH links
            urls: {
                public: `https://ipfs.io/ipfs/${rows[0].ipfs_hash}`,            // Slow, Universal
                local:  `http://${SERVER_IP}:8080/ipfs/${rows[0].ipfs_hash}`    // Instant, WiFi-only
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));