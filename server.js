require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // Thay thế sqlite bằng pg
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');

const app = express();

// 1. Sửa lỗi đọc biến môi trường và ADMIN_EMAILS
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID.replace(/['";\s]/g, '');
const ADMIN_EMAILS = JSON.parse(process.env.ADMIN_EMAILS || "[]");

// 2. Cấu hình Cloudinary + TỰ ĐỘNG NÉN ẢNH (Giai đoạn 2)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
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
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// 3. Khởi tạo PostgreSQL Pool (Giai đoạn 1)
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
                mssv TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS votes_history (
                id SERIAL PRIMARY KEY,
                voter_email TEXT,
                photo_id INTEGER,
                UNIQUE(voter_email, photo_id)
            );
        `);
        console.log("✅ PostgreSQL initialized successfully.");
    } catch (err) {
        console.error("❌ Database initialization error:", err);
    }
})();

// --- CÁC API ĐÃ CHUYỂN ĐỔI SANG POSTGRESQL ---

// API Lấy ảnh
app.get('/api/photos', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const search = req.query.search || '';
    const sort = req.query.sort === 'top' ? 'votes DESC' : 'id DESC';
    const limit = 6;
    const offset = (page - 1) * limit;

    try {
        // Postgres dùng $1, $2 thay cho ?
// Chỉ lấy giá trị created_at trực tiếp, không ép múi giờ trong SQL nữa
// vì chúng ta sẽ xử lý bằng JavaScript ở bước sau
        const result = await pool.query(`
            SELECT *, created_at as time_raw 
            FROM photos 
            WHERE uploader_name ILIKE $1 OR mssv ILIKE $2 
            ORDER BY ${sort} LIMIT $3 OFFSET $4`, 
            [`%${search}%`, `%${search}%`, limit, offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Lỗi lấy dữ liệu" });
    }
});

// API Lấy photo_id user đã vote
app.get('/api/my-vote', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.json({ photo_id: null });
    
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;
        const result = await pool.query('SELECT photo_id FROM votes_history WHERE voter_email = $1', [email]);
        res.json({ photo_id: result.rows.length > 0 ? result.rows[0].photo_id : null });
    } catch (error) {
        res.json({ photo_id: null });
    }
});

// API Đăng ảnh - Lọc email TDTU
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { token, mssv } = req.body;
    if (!req.file || !token || !mssv) return res.status(400).json({ message: "Thiếu thông tin!" });

    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email;

        // BẢO MẬT: Chỉ cho phép sinh viên TDTU
        if (!email.endsWith('@student.tdtu.edu.vn')) {
            return res.status(403).json({ message: "Vui lòng dùng email sinh viên TDTU!" });
        }

        const isAdmin = ADMIN_EMAILS.includes(email);
        if (!isAdmin) {
            const existing = await pool.query('SELECT id FROM photos WHERE uploader_email = $1', [email]);
            if (existing.rows.length > 0) {
                const publicId = `photo_voter_pro/${req.file.path.split('/').pop().split('.')[0]}`;
                await cloudinary.uploader.destroy(publicId);
                return res.status(400).json({ message: "Bạn đã đăng ảnh rồi!" });
            }
        }

        await pool.query(
            'INSERT INTO photos (url, uploader_name, uploader_email, mssv) VALUES ($1, $2, $3, $4)',
            [req.file.path, payload.name, email, mssv]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(401).json({ message: "Lỗi xác thực!" });
    }
});

// API Cập nhật ảnh (Reset vote)
app.put('/api/update-photo', upload.single('photo'), async (req, res) => {
    const { token, mssv } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;

        const oldPhoto = await pool.query('SELECT * FROM photos WHERE uploader_email = $1', [email]);
        if (oldPhoto.rows.length === 0) return res.status(404).json({ message: "Chưa có ảnh!" });

        const urlParts = oldPhoto.rows[0].url.split('/');
        const fileName = urlParts[urlParts.length - 1].split('.')[0];
        const publicId = `photo_voter_pro/${fileName}`;
        await cloudinary.uploader.destroy(publicId);

        await pool.query('UPDATE photos SET url = $1, votes = 0, mssv = $2 WHERE uploader_email = $3', [req.file.path, mssv, email]);
        await pool.query('DELETE FROM votes_history WHERE photo_id = $1', [oldPhoto.rows[0].id]);

        res.json({ success: true });
    } catch (error) {
        res.status(401).json({ message: "Lỗi hệ thống!" });
    }
});

// API Xuất file CSV cho Admin (Fix lỗi font tiếng Việt & MSSV dạng Text)
// API Xuất file CSV cho Admin (Fix lỗi biến không xác định & chuẩn múi giờ)
app.get('/api/admin/export', async (req, res) => {
    const token = req.query.token;
    try {
        // 1. Xác thực Admin
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;
        if (!ADMIN_EMAILS.includes(email)) return res.status(403).send("Forbidden");

        // 2. Lấy TOÀN BỘ dữ liệu (Không dùng limit/offset ở đây để xuất được hết danh sách)
        const result = await pool.query(`
            SELECT uploader_name, mssv, votes, uploader_email, created_at 
            FROM photos 
            ORDER BY votes DESC
        `);

        // 3. Tạo nội dung CSV với BOM để fix lỗi font
        let csvContent = '\uFEFF'; 
        csvContent += 'Họ Tên,MSSV,Số Vote,Email,Thời Gian Đăng\n';

        result.rows.forEach(row => {
            const name = `"${row.uploader_name.replace(/"/g, '""')}"`; 
            const mssv = `="${row.mssv}"`; 
            const votes = row.votes;
            const uEmail = row.uploader_email;
            
            // Xử lý thời gian chuẩn Việt Nam
            const time = new Date(row.created_at).toLocaleString('vi-VN', { 
                timeZone: 'Asia/Ho_Chi_Minh',
                hour12: false 
            });

            csvContent += `${name},${mssv},${votes},${uEmail},${time}\n`;
        });

        // 4. Gửi file về trình duyệt
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=ds_binh_chon_tdtu.csv');
        res.status(200).send(csvContent);

    } catch (error) {
        console.error("Export error:", error);
        res.status(500).json({ message: "Lỗi hệ thống khi xuất file!" });
    }
});
const rateLimit = require('express-rate-limit');

// Cấu hình giới hạn: 1 IP/User chỉ được gọi API Vote 2 lần mỗi phút (tránh nhấn liên tục)
const voteLimiter = rateLimit({
    windowMs: 30 * 1000, // Khoảng thời gian 30 giây
    max: 2, // Tối đa 2 lần (1 lần Vote + có thể 1 lần Unvote nhầm)
    message: { message: "Bạn thao tác quá nhanh! Vui lòng đợi 30 giây." },
    standardHeaders: true,
    legacyHeaders: false,
}); 

// API Bình chọn (Hỗ trợ Unvote)
app.post('/api/vote/:id', voteLimiter, async (req, res) => {
    const { token } = req.body;
    const newPhotoId = parseInt(req.params.id);
    
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;

        const existing = await pool.query('SELECT photo_id FROM votes_history WHERE voter_email = $1', [email]);

        if (existing.rows.length > 0) {
            const oldPhotoId = existing.rows[0].photo_id;
            await pool.query('UPDATE photos SET votes = GREATEST(0, votes - 1) WHERE id = $1', [oldPhotoId]);
            await pool.query('DELETE FROM votes_history WHERE voter_email = $1', [email]);

            if (oldPhotoId === newPhotoId) {
                return res.json({ success: true, action: 'unvoted' });
            }
        }

        await pool.query('INSERT INTO votes_history (voter_email, photo_id) VALUES ($1, $2)', [email, newPhotoId]);
        await pool.query('UPDATE photos SET votes = votes + 1 WHERE id = $1', [newPhotoId]);
        res.json({ success: true, action: 'voted' });
    } catch (error) {
        res.status(400).json({ message: "Lỗi bình chọn!" });
    }
});

// API Admin Summary
app.get('/api/admin/summary', async (req, res) => {
    const token = req.query.token;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        if (!ADMIN_EMAILS.includes(ticket.getPayload().email)) return res.status(403).send("Forbidden");

        const result = await pool.query('SELECT uploader_name, uploader_email, mssv, votes, url FROM photos ORDER BY votes DESC');
        res.json(result.rows);
    } catch (error) {
        res.status(401).send("Unauthorized");
    }
});

// API Xóa ảnh: Admin xóa tất cả, User chỉ xóa được ảnh của mình
app.delete('/api/photos/:id', async (req, res) => {
    const photoId = parseInt(req.params.id);
    const { token } = req.body;

    if (!token) return res.status(401).json({ message: "Thiếu xác thực!" });

    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;
        const isAdmin = ADMIN_EMAILS.includes(email);

        const photoResult = await pool.query('SELECT * FROM photos WHERE id = $1', [photoId]);
        if (photoResult.rows.length === 0) return res.status(404).json({ message: "Không tìm thấy ảnh!" });

        const photo = photoResult.rows[0];

        // KIỂM TRA QUYỀN
        if (!isAdmin && photo.uploader_email !== email) {
            return res.status(403).json({ message: "Bạn không có quyền xóa ảnh này!" });
        }

        // Xóa trên Cloudinary
        // Tìm đoạn lấy publicId cũ và thay bằng:
        const urlParts = photo.url.split('/');
        const fileName = urlParts[urlParts.length - 1].split('.')[0];
        const publicId = `photo_voter_pro/${fileName}`;
        await cloudinary.uploader.destroy(publicId);

        // Xóa trong Database
        await pool.query('DELETE FROM votes_history WHERE photo_id = $1', [photoId]);
        await pool.query('DELETE FROM photos WHERE id = $1', [photoId]);

        res.json({ success: true, message: "Đã xóa ảnh thành công!" });
    } catch (error) {
        res.status(401).json({ message: "Lỗi xác thực hoặc hệ thống!" });
    }
});

app.listen(3000, () => console.log('🚀 Server Pro running at http://localhost:3000'));