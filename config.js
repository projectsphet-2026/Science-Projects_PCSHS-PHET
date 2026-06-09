/**
 * config.js — ค่าตั้งสำหรับหน้าเว็บบน GitHub Pages
 * แก้ 3 ค่านี้ให้เป็นของโปรเจกต์คุณ (ดู PHASE5_README.md)
 *
 *  - SUPABASE_URL       : Settings → API → Project URL
 *  - SUPABASE_ANON_KEY  : Settings → API → Project API keys → anon public
 *                         (anon key ใส่ในหน้าเว็บได้ ปลอดภัยเพราะถูกคุมด้วย RLS)
 *  - GAS_WEBAPP_URL     : URL ของ "Cloudflare Worker" (proxy หน้า GAS) — ใช้เฉพาะ upload + face login
 *                         (เฟส 6: login/รหัสผ่าน ย้ายไป Supabase RPC แล้ว ไม่ผ่าน GAS)
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://soycsmjuxtfrpbvjgllj.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNveWNzbWp1eHRmcnBidmpnbGxqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MjM3MTAsImV4cCI6MjA5NjQ5OTcxMH0.vEvp5JZ1uC-C43zv65fKiGZCkZiQ62pSh-zY-Kx_lco',
  GAS_WEBAPP_URL: 'https://phet-upload-proxy.kittipat-rot.workers.dev/'
};
