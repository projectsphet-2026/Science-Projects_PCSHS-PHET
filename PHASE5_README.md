# เฟส 5 — Frontend บน GitHub Pages (เรียก Supabase ตรง)

หน้าเว็บย้ายไป host บน **GitHub Pages** แล้วคุยกับ backend แบบนี้:
- **ข้อมูล (อ่าน/เขียน DB):** เรียก **Supabase ตรง** ด้วย supabase-js (RLS+JWT คุมสิทธิ์)
- **login + อัปโหลดไฟล์ + เปลี่ยนรหัสผ่าน:** เรียก **GAS Web App** (`webapp.gs` → `doPost`)

> **เคล็ดลับที่ทำให้ไม่ต้องแก้โค้ด component เลย:** `supabase-api.js` ทำ **shim ของ
> `google.script.run`** → โค้ด React เดิมเรียก backend เหมือนเดิม แต่ถูก route ไป
> supabase-js / GAS ให้อัตโนมัติ

## ไฟล์
| ไฟล์ | บทบาท |
|------|-------|
| `webapp.gs` (ในโปรเจกต์ GAS) | `doPost` รับ login/upload/เปลี่ยนรหัส (มี guard JWT) |
| `web/index.html` | หน้าเว็บ (สร้างจาก `build-web.js`) — แทรก supabase-js + bridge |
| `web/config.js` | URL/key (แก้ก่อน deploy) |
| `web/supabase-api.js` | supabase client + `gasCall` + shim + ฟังก์ชัน backend ทั้งหมด |
| `build-web.js` | ประกอบ `web/index.html` จาก `Index.html` |

---

## ขั้นตอน deploy

### 1) Deploy GAS เป็น Web App
1. `clasp push` (ดันโค้ด GAS ล่าสุด รวม `webapp.gs`)
2. Apps Script → **Deploy → New deployment** → เลือก type **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
3. คัดลอก **Web app URL** (ลงท้าย `/exec`)

> ต้องตั้ง Script Property `SUPABASE_JWT_SECRET` แล้ว (เฟส 4) — login ถึงจะคืน token
> และ guard เปลี่ยนรหัสผ่านถึงจะทำงาน

### 2) ตั้งค่า `web/config.js`
แก้ 3 ค่า:
```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: '...anon public key...',   // Settings → API → anon public
  GAS_WEBAPP_URL: 'https://script.google.com/macros/s/.../exec'
};
```

### 3) สร้างหน้าเว็บ
```bash
node build-web.js     # ได้ web/index.html
```

### 4) Push ขึ้น GitHub Pages
- เอาไฟล์ในโฟลเดอร์ **`web/`** (`index.html`, `config.js`, `supabase-api.js`) ขึ้น repo
- repo → **Settings → Pages** → Source = branch + โฟลเดอร์ที่วางไฟล์ → Save
- รอสักครู่ได้ URL `https://<user>.github.io/<repo>/`

---

## ทดสอบ
1. เปิด URL GitHub Pages → **login** → ดู console: `[supabase-api] พร้อมใช้งาน`
2. login สำเร็จ → `window.sb.auth.getSession()` ต้องมี session (JWT)
3. ดูข้อมูลโครงงาน/โพสต์ขึ้นครบ (อ่านผ่าน RLS)
4. ลองเขียน เช่น กด like / ส่งคำร้อง → เข้าราง Supabase
5. อัปโหลดรูป → ขึ้น Drive + meta เข้า Supabase
6. **เทียบกับแอป GAS เดิม** (ที่ยังรันคู่ขนาน) ว่าผลเหมือนกัน

---

## หมายเหตุ/ข้อควรระวัง
- **CORS:** `gasCall` ใช้ `Content-Type: text/plain` (simple request) → GAS `/exec` ตอบ
  cross-origin ได้ ถ้าเจอปัญหา CORS ให้ตรวจว่า deploy เป็น Web App (Anyone) แล้ว
- **JWT อายุ 8 ชม. + ต่ออายุอัตโนมัติ** — `supabase-api.js` ต่ออายุ token ให้เองทุก 6 ชม.
  และตอนกลับมาโฟกัสแท็บ (ผ่าน action `refreshToken` ของ GAS) ถ้าทิ้งแท็บไว้นานเกิน
  8 ชม. จน token หมดจริง → query จะถูก RLS ปฏิเสธ ให้ login ใหม่
  (เรียกเองได้ที่ `window.refreshSupabaseSession()`)
- **anon key ใส่ใน config.js ได้** (ปลอดภัยเพราะ RLS คุม) — **ห้ามใส่ service_role key**
- **เปลี่ยนรหัสผ่าน** ผ่าน `__setpw__`/`__setpw_bulk__` มี guard ตรวจ JWT (admin หรือเจ้าของ)
- แอป GAS เดิมยังใช้ได้ (doGet ยังอยู่) — เก็บไว้ rollback ได้จนกว่าจะมั่นใจ
- ฟังก์ชัน backend ทั้งหมดถูก port ไว้ใน `supabase-api.js` แล้ว — ถ้า component เรียกชื่อใด
  ที่ยังไม่มี จะขึ้น error `ไม่มีฟังก์ชัน backend: <ชื่อ>` ใน console (แจ้งมาได้ เดี๋ยวเพิ่มให้)
