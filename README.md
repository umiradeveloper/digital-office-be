# Digital Office — Backend (NestJS + Prisma + MySQL)

```bash
npm install
cp .env.example .env
mysql -u root -p < prisma/setup-database.sql   # database + user MySQL
npm run db:setup                               # tabel + data uji (akun demo, kata sandi Password123!)
npm run dev                                    # http://localhost:4000/api/v1
```

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Mode development (auto-reload) |
| `npm run build && npm run start:prod` | Produksi |
| `npm run db:push` | Sinkronkan skema `prisma/schema.prisma` ke MySQL |
| `npm run db:seed` | Isi ulang data uji (**menghapus semua data**) |
| `npm run import:superapps -- --db` | Sinkron user SuperApps (lihat README utama) |
| `npm test` | Uji unit routing approval |

File yang diunggah tersimpan di `STORAGE_DIR` (default `./storage`) — sertakan folder ini dalam backup bersama database.
