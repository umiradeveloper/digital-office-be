-- Membuat database & user MySQL untuk Digital Office (jalankan sekali sebagai root):
--   mysql -u root -p < prisma/setup-database.sql
-- Ganti password 'digital' di sini dan di DATABASE_URL (.env) untuk server produksi.
CREATE DATABASE IF NOT EXISTS digital_office CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'digital'@'localhost' IDENTIFIED BY 'digital';
CREATE USER IF NOT EXISTS 'digital'@'127.0.0.1' IDENTIFIED BY 'digital';
GRANT ALL PRIVILEGES ON digital_office.* TO 'digital'@'localhost';
GRANT ALL PRIVILEGES ON digital_office.* TO 'digital'@'127.0.0.1';
FLUSH PRIVILEGES;
