# 📸 TDTU Voter

![TDTU Voter Banner](https://img.shields.io/badge/TDTU-Voter_Project-111111?style=for-the-badge&logo=appveyor)

**TDTU Voter** là một nền tảng website tối giản (minimalism) dùng để tổ chức các cuộc thi bình chọn ảnh nghệ thuật dành riêng cho sinh viên Đại học Tôn Đức Thắng (TDTU). 

Ứng dụng cung cấp giải pháp trọn gói từ việc tải ảnh lên, nén ảnh tự động, đăng nhập bằng tài khoản Google sinh viên (giới hạn đuôi `@student.tdtu.edu.vn`), cho đến việc bình chọn thời gian thực và một Dashboard quản lý chuyên nghiệp dành cho Admin.

---

## ✨ Tính năng nổi bật

- 🔐 **Xác thực sinh viên TDTU:** Tích hợp Google OAuth2, chỉ cho phép email `@student.tdtu.edu.vn` được tải ảnh và bình chọn.
- 🎨 **Minimalist UI/UX:** Giao diện tối giản, sang trọng lấy cảm hứng từ Dribbble & Behance. Responsive hoàn hảo trên mọi thiết bị (Mobile, Tablet, Desktop).
- ☁️ **Lưu trữ Cloudinary:** Tự động tối ưu hoá, thay đổi kích thước và nén ảnh phía client & server trước khi lưu trữ lên Cloudinary.
- ❤️ **Bình chọn công bằng:** Mỗi sinh viên chỉ được phép có 1 vote duy nhất (có thể đổi vote, lúc đó vote cũ sẽ bị hủy). Hỗ trợ khóa API Rate-limit chống spam click.
- 🛡️ **Admin Dashboard:** Bảng điều khiển dành riêng cho Admin được cấu hình từ trước, cho phép quản lý dự thi, xem danh sách và xuất dữ liệu ra file **CSV (Excel)** chỉ bằng 1 nút bấm.

---

## 🛠 Tech Stack

**Frontend:**
- HTML5 / CSS3 / JavaScript (Vanilla)
- [Tailwind CSS](https://tailwindcss.com/) (Dùng qua CDN cho giao diện)
- [Google Sign-In (GSI)](https://developers.google.com/identity/gsi/web)
- [Toastify-JS](https://apvarun.github.io/toastify-js/) (Thông báo dạng pop-up)

**Backend:**
- [Node.js](https://nodejs.org/) & [Express.js](https://expressjs.com/)
- [PostgreSQL](https://www.postgresql.org/) (Sử dụng thư viện `pg` pooling)
- [Cloudinary](https://cloudinary.com/) & `multer-storage-cloudinary` (Quản lý ảnh)
- `google-auth-library` (Verify Google ID Token)

---

## ⚙️ Yêu cầu môi trường

- **Node.js**: v18.x hoặc mới hơn.
- **Cơ sở dữ liệu**: PostgreSQL (Có thể dùng database local hoặc dịch vụ cloud như Supabase, Neon, v.v.).
- Tải khoản Cloudinary API.
- Google OAuth2 Client ID.

---

## 🚀 Hướng dẫn cài đặt và chạy thử

### 1. Clone dự án

```bash
git clone <LINK_REPO_CỦA_BẠN>
cd DoanCNTT
```

### 2. Cài đặt các thư viện phụ thuộc (Dependencies)

```bash
npm install
```

### 3. Cấu hình biến môi trường

Tạo một file `.env` tại thư mục gốc của dự án và điền các thông số sau:

```env
# Cấu hình Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Cấu hình Google Auth
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com

# Danh sách Admin Emails (Định dạng mảng JSON thuần)
ADMIN_EMAILS=["admin@student.tdtu.edu.vn", "admin2@student.tdtu.edu.vn"]

# Database PostgreSQL URL
DATABASE_URL="postgres://username:password@host:port/database_name"
```

### 4. Khởi động server

```bash
npm start
# Hoặc: node server.js
```

Sau khi Terminal hiển thị `🚀 Server Pro running at http://localhost:3000`, bạn có thể mở trình duyệt và truy cập vào: [http://localhost:3000](http://localhost:3000)

---

## 🗄 Cấu trúc Database (PostgreSQL)

Hệ thống sẽ **tự động khởi tạo** các Table cần thiết khi chạy server lần đầu. Cấu trúc bao gồm:

- `photos`: Lưu ID, URL ảnh, số lượt vote, tên, email, MSSV của thí sinh và thời gian đăng.
- `votes_history`: Lưu email người bình chọn và `photo_id` tương ứng để theo dõi 1-vote-per-user.

---

## 📝 Bản quyền và Tác giả

Được phát triển bởi tôi.
Dự án được xây dựng với mục đích phục vụ cộng đồng sinh viên, các cuộc thi nhiếp ảnh và văn thể mỹ trực thuộc tổ chức.
