require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const ExcelJS = require('exceljs');

const app = express();

if (!process.env.GOOGLE_CLIENT_ID) {
    console.error("❌ FATAL: Biến môi trường GOOGLE_CLIENT_ID chưa được set! Vào phần Environment Variables trên Render/Railway và thêm GOOGLE_CLIENT_ID giống với client_id dùng ở index.html.");
}
// Loại bỏ dấu nháy / khoảng trắng dư khi copy-paste vào .env
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').replace(/['"\s]/g, '');
console.log("[Config] GOOGLE_CLIENT_ID đang dùng:", GOOGLE_CLIENT_ID || "(RỖNG - CHƯA SET!)");

const ADMIN_EMAILS = JSON.parse(process.env.ADMIN_EMAILS || "[]");
console.log("[Config] ADMIN_EMAILS đang dùng:", ADMIN_EMAILS);

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary,
    params: { 
        folder: 'photo_voter_pro', 
        allowed_formats: ['jpg', 'png', 'jpeg'],
        transformation: [
            { width: 1000, crop: "limit" }, 
            { quality: "auto" },            
            { fetch_format: "auto" }        
        ]
    },
});
const upload = multer({ storage });

app.use(express.static('public'));
app.use(express.json());

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS photos (
                id SERIAL PRIMARY KEY, 
                url TEXT NOT NULL, 
                votes INTEGER DEFAULT 0,
                uploader_name TEXT,
                uploader_email TEXT,
                birth_year TEXT,
                school TEXT,
                relative_name TEXT,
                relative_phone TEXT,
                caption TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS votes_history (
                id SERIAL PRIMARY KEY,
                voter_id TEXT,
                photo_id INTEGER,
                UNIQUE(voter_id, photo_id)
            );
        `);

        // Migrations cho DB cũ
        const migrations = [
            `ALTER TABLE photos ADD COLUMN IF NOT EXISTS birth_year TEXT`,
            `ALTER TABLE photos ADD COLUMN IF NOT EXISTS school TEXT`,
            `ALTER TABLE photos ADD COLUMN IF NOT EXISTS relative_name TEXT`,
            `ALTER TABLE photos ADD COLUMN IF NOT EXISTS relative_phone TEXT`,
            `ALTER TABLE photos ADD COLUMN IF NOT EXISTS caption TEXT`,
            `ALTER TABLE votes_history ADD COLUMN IF NOT EXISTS voter_id TEXT`,
        ];
        for (const sql of migrations) {
            await pool.query(sql);
        }

        console.log("✅ PostgreSQL initialized successfully.");
    } catch (err) {
        console.error("❌ Database initialization error:", err);
    }
})();

// ─── Validate fields ────────────────────────────────────────────────
function validateFields({ uploader_name, birth_year, school, relative_name, relative_phone, caption }) {
    if (!uploader_name || uploader_name.trim().length < 2)
        return "Vui lòng nhập họ và tên!";
    if (!birth_year || !/^\d{4}$/.test(birth_year))
        return "Năm sinh không hợp lệ! (VD: 2000)";
    const year = parseInt(birth_year);
    if (year < 1930 || year > new Date().getFullYear())
        return "Năm sinh không hợp lệ!";
    if (!school || school.trim().length < 2)
        return "Vui lòng nhập tên trường học!";
    if (!relative_name || relative_name.trim().length < 2)
        return "Vui lòng nhập họ tên người thân!";
    const phoneClean = (relative_phone || '').replace(/\s/g, '');
    if (!/^(0|\+84)[0-9]{9}$/.test(phoneClean))
        return "Số điện thoại người thân không hợp lệ! (VD: 0912345678)";
    if (!caption || caption.trim() === '')
        return "Vui lòng nhập ghi chú cho ảnh!";
    if (caption.length > 500)
        return "Ghi chú không được vượt quá 500 ký tự!";
    return null;
}

// ─── API: Lấy ảnh (PUBLIC) ──────────────────────────────────────────
app.get('/api/photos', async (req, res) => {
    const page   = parseInt(req.query.page) || 1;
    const search = req.query.search || '';
    const sort   = req.query.sort === 'top' ? 'votes DESC' : 'id DESC';
    const limit  = 6;
    const offset = (page - 1) * limit;
    try {
        const result = await pool.query(`
            SELECT *, created_at as time_raw 
            FROM photos 
            WHERE uploader_name ILIKE $1 OR school ILIKE $2 
            ORDER BY ${sort} LIMIT $3 OFFSET $4`, 
            [`%${search}%`, `%${search}%`, limit, offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Lỗi lấy dữ liệu ảnh:", error);
        res.status(500).json({ message: "Lỗi lấy dữ liệu" });
    }
});

// ─── API: Kiểm tra voter đã vote chưa (PUBLIC – dùng token Google) ──
app.get('/api/my-vote', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.json({ photo_id: null });
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const voter_id = ticket.getPayload().sub;
        const result = await pool.query(
            'SELECT photo_id FROM votes_history WHERE voter_id = $1', [voter_id]
        );
        res.json({ photo_id: result.rows.length > 0 ? result.rows[0].photo_id : null });
    } catch (error) {
        console.error('[My-Vote] verifyIdToken THẤT BẠI:', error.message, '| GOOGLE_CLIENT_ID server:', GOOGLE_CLIENT_ID);
        res.status(401).json({ message: "Phiên đăng nhập hết hạn!" });
    }
});

// ─── API: Đăng ảnh (PUBLIC – không cần Google) ──────────────────────
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { uploader_name, birth_year, school, relative_name, relative_phone, caption } = req.body;
    
    if (!req.file) return res.status(400).json({ message: "Thiếu ảnh!" });

    const err = validateFields({ uploader_name, birth_year, school, relative_name, relative_phone, caption });
    if (err) return res.status(400).json({ message: err });

    const phoneClean = relative_phone.replace(/\s/g, '');

    try {
        // Kiểm tra trùng số điện thoại người thân
        const existing = await pool.query(
            'SELECT id FROM photos WHERE relative_phone = $1', [phoneClean]
        );
        if (existing.rows.length > 0) {
            // Xóa ảnh vừa upload trên Cloudinary
            const publicId = `photo_voter_pro/${req.file.path.split('/').pop().split('.')[0]}`;
            await cloudinary.uploader.destroy(publicId);
            return res.status(400).json({ message: "Số điện thoại người thân này đã được dùng để đăng ảnh!" });
        }

        await pool.query(
            `INSERT INTO photos (url, uploader_name, uploader_email, birth_year, school, relative_name, relative_phone, caption) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [req.file.path, uploader_name.trim(), '', birth_year.trim(), school.trim(), relative_name.trim(), phoneClean, caption.trim()]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Lỗi khi upload ảnh:", error);
        res.status(500).json({ message: "Lỗi hệ thống!" });
    }
});

// ─── API: Cập nhật ảnh – ĐÃ TẮT ────────────────────────────────────
app.put('/api/update-photo', (req, res) => {
    return res.status(403).json({ message: "Chức năng thay đổi ảnh đã bị tắt!" });
});

// ─── API: Xuất Excel (Admin only) ───────────────────────────────────
app.get('/api/admin/export', async (req, res) => {
    const token = req.query.token;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email  = ticket.getPayload().email;
        if (!ADMIN_EMAILS.includes(email)) return res.status(403).send("Forbidden");

        const result = await pool.query(`
            SELECT uploader_name, birth_year, school, relative_name, relative_phone, votes, caption, created_at 
            FROM photos ORDER BY votes DESC
        `);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Voting System';
        workbook.created = new Date();

        const ws = workbook.addWorksheet('Danh sách bình chọn', {
            pageSetup: { fitToPage: true, fitToWidth: 1, orientation: 'landscape' }
        });

        ws.columns = [
            { header: 'STT',              key: 'stt',            width: 6  },
            { header: 'Họ và Tên',         key: 'name',           width: 24 },
            { header: 'Năm Sinh',          key: 'birth_year',     width: 12 },
            { header: 'Trường Học',        key: 'school',         width: 28 },
            { header: 'Tên Người Thân',    key: 'relative_name',  width: 22 },
            { header: 'SĐT Người Thân',    key: 'relative_phone', width: 16 },
            { header: 'Số Vote',           key: 'votes',          width: 10 },
            { header: 'Ghi Chú',          key: 'caption',        width: 40 },
            { header: 'Thời Gian Đăng',   key: 'time',           width: 20 },
        ];

        // Header style
        const headerRow = ws.getRow(1);
        headerRow.height = 32;
        headerRow.eachCell(cell => {
            cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border    = { top:{style:'thin',color:{argb:'FF374151'}}, left:{style:'thin',color:{argb:'FF374151'}}, bottom:{style:'thin',color:{argb:'FF374151'}}, right:{style:'thin',color:{argb:'FF374151'}} };
        });

        result.rows.forEach((row, i) => {
            const time = new Date(row.created_at).toLocaleString('vi-VN', {
                timeZone: 'Asia/Ho_Chi_Minh', hour12: false
            });
            const dataRow = ws.addRow({
                stt: i + 1, name: row.uploader_name || '',
                birth_year: row.birth_year || '', school: row.school || '',
                relative_name: row.relative_name || '', relative_phone: row.relative_phone || '',
                votes: row.votes || 0, caption: row.caption || '', time,
            });
            dataRow.height = 22;
            const bg = i % 2 === 0 ? 'FFFFFFFF' : 'FFF9FAFB';
            dataRow.eachCell(cell => {
                cell.font      = { size: 10, name: 'Calibri' };
                cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border    = { top:{style:'hair',color:{argb:'FFE5E7EB'}}, left:{style:'hair',color:{argb:'FFE5E7EB'}}, bottom:{style:'hair',color:{argb:'FFE5E7EB'}}, right:{style:'hair',color:{argb:'FFE5E7EB'}} };
            });
            dataRow.getCell('stt').alignment       = { horizontal: 'center', vertical: 'middle' };
            dataRow.getCell('birth_year').alignment = { horizontal: 'center', vertical: 'middle' };
            const vc = dataRow.getCell('votes');
            vc.font = { bold: true, size: 11, name: 'Calibri' };
            vc.alignment = { horizontal: 'center', vertical: 'middle' };
            if (i === 0) vc.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFD700'} };
            if (i === 1) vc.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFC0C0C0'} };
            if (i === 2) vc.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFCD7F32'} };
        });

        ws.views = [{ state: 'frozen', ySplit: 1 }];
        ws.autoFilter = { from: 'A1', to: 'I1' };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=ds_binh_chon.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Export error:", error.message, '| GOOGLE_CLIENT_ID server:', GOOGLE_CLIENT_ID);
        res.status(500).json({ message: "Lỗi hệ thống khi xuất file!" });
    }
});

// ─── Rate limit vote ─────────────────────────────────────────────────
const rateLimit = require('express-rate-limit');
const voteLimiter = rateLimit({
    windowMs: 30 * 1000, max: 2,
    message: { message: "Bạn thao tác quá nhanh! Vui lòng đợi 30 giây." },
    standardHeaders: true, legacyHeaders: false,
}); 

// ─── API: Bình chọn (PUBLIC – dùng token Google) ───────────────────
app.post('/api/vote/:id', voteLimiter, async (req, res) => {
    const { token } = req.body;
    const newPhotoId = parseInt(req.params.id);

    if (!token) return res.status(401).json({ message: "Vui lòng đăng nhập bằng Google để bình chọn!" });

    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const voter_id = ticket.getPayload().sub;

        const existing = await pool.query(
            'SELECT photo_id FROM votes_history WHERE voter_id = $1', [voter_id]
        );

        if (existing.rows.length > 0) {
            const oldPhotoId = existing.rows[0].photo_id;
            await pool.query('UPDATE photos SET votes = GREATEST(0, votes - 1) WHERE id = $1', [oldPhotoId]);
            await pool.query('DELETE FROM votes_history WHERE voter_id = $1', [voter_id]);
            if (oldPhotoId === newPhotoId)
                return res.json({ success: true, action: 'unvoted' });
        }

        await pool.query(
            'INSERT INTO votes_history (voter_id, photo_id) VALUES ($1, $2)', [voter_id, newPhotoId]
        );
        await pool.query('UPDATE photos SET votes = votes + 1 WHERE id = $1', [newPhotoId]);
        res.json({ success: true, action: 'voted' });
    } catch (error) {
        console.error("Lỗi khi bình chọn:", error);
        res.status(401).json({ message: "Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại!" });
    }
});

// ─── API: Admin Summary ──────────────────────────────────────────────
app.get('/api/admin/summary', async (req, res) => {
    const token = req.query.token;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;
        console.log('[Admin Summary] Email verify OK:', email);
        if (!ADMIN_EMAILS.includes(email)) {
            console.log('[Admin Summary] Email không trong ADMIN_EMAILS:', email, '| ADMIN_EMAILS:', ADMIN_EMAILS);
            return res.status(403).send("Forbidden");
        }
        const result = await pool.query(
            'SELECT uploader_name, birth_year, school, relative_name, relative_phone, votes, caption, created_at FROM photos ORDER BY votes DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[Admin Summary] verifyIdToken THẤT BẠI:', err.message);
        res.status(401).send("Unauthorized");
    }
});

// ─── API: Xóa ảnh (Admin only) ──────────────────────────────────────
app.delete('/api/photos/:id', async (req, res) => {
    const photoId = parseInt(req.params.id);
    const { token } = req.body;

    if (!token) return res.status(401).json({ message: "Chỉ Admin mới có quyền xóa ảnh!" });

    try {
        const ticket  = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email   = ticket.getPayload().email;
        const isAdmin = ADMIN_EMAILS.includes(email);

        if (!isAdmin) return res.status(403).json({ message: "Bạn không có quyền xóa ảnh!" });

        const photoResult = await pool.query('SELECT * FROM photos WHERE id = $1', [photoId]);
        if (photoResult.rows.length === 0) return res.status(404).json({ message: "Không tìm thấy ảnh!" });

        const photo    = photoResult.rows[0];
        const urlParts = photo.url.split('/');
        const fileName = urlParts[urlParts.length - 1].split('.')[0];
        await cloudinary.uploader.destroy(`photo_voter_pro/${fileName}`);

        await pool.query('DELETE FROM votes_history WHERE photo_id = $1', [photoId]);
        await pool.query('DELETE FROM photos WHERE id = $1', [photoId]);

        res.json({ success: true, message: "Đã xóa ảnh thành công!" });
    } catch (error) {
        console.error("Lỗi khi xóa ảnh:", error);
        res.status(401).json({ message: "Lỗi xác thực hoặc hệ thống!" });
    }
});

app.listen(3000, () => console.log('🚀 Server running at http://localhost:3000'));