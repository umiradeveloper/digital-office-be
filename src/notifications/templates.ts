/** Template e-mail default (dapat diubah admin via UI — FR-NTF-02). */
export const DEFAULT_TEMPLATES: Record<string, { name: string; subject: string; body: string; minPriority?: 'low' | 'med' | 'high' | 'crit' }> = {
  submitted: {
    name: 'Request dibuat / dikirim',
    subject: '[{{ref}}] Request Anda telah dikirim',
    body: 'Halo {{nama}},\n\nRequest "{{judul}}" ({{ref}}) berhasil dikirim dengan status {{status}}.\nPrioritas: {{prioritas}}\n\nPantau perkembangannya di {{link}}',
  },
  assigned: {
    name: 'Ditugaskan sebagai penanggung jawab',
    subject: '[{{ref}}] Anda ditugaskan: {{judul}}',
    body: 'Halo {{nama}},\n\n{{aktor}} menugaskan Anda pada "{{judul}}" ({{ref}}).\nJatuh tempo: {{due}}\n\nBuka: {{link}}',
  },
  pending_approval: {
    name: 'Perlu approval',
    subject: '[{{ref}}] Menunggu approval Anda — {{level}}',
    body: 'Halo {{nama}},\n\nRequest "{{judul}}" dari {{pengaju}} menunggu keputusan Anda pada {{level}}.\nPrioritas: {{prioritas}} · Jatuh tempo: {{due}}\n\nProses di {{link}}',
  },
  approved: {
    name: 'Disetujui',
    subject: '[{{ref}}] Request disetujui',
    body: 'Halo {{nama}},\n\nRequest "{{judul}}" telah disetujui sepenuhnya.\nKeputusan terakhir oleh {{aktor}}.\n\nDetail: {{link}}',
  },
  rejected: {
    name: 'Ditolak',
    subject: '[{{ref}}] Request ditolak — perlu revisi',
    body: 'Halo {{nama}},\n\nRequest "{{judul}}" ditolak oleh {{aktor}} pada {{level}}.\nAlasan: {{alasan}}\n\nSilakan revisi dan kirim ulang melalui {{link}}',
  },
  delegated: {
    name: 'Didelegasikan',
    subject: '[{{ref}}] Anda menerima delegasi approval',
    body: 'Halo {{nama}},\n\n{{delegator}} mendelegasikan hak approval kepada Anda. {{periode}}\n\n{{judul}}\n\nBuka inbox approval: {{link}}',
  },
  due_tomorrow: {
    name: 'Jatuh tempo besok',
    subject: '[{{ref}}] Jatuh tempo besok: {{judul}}',
    body: 'Halo {{nama}},\n\nRequest "{{judul}}" jatuh tempo pada {{due}}. Status saat ini: {{status}}.\n\nBuka: {{link}}',
  },
  overdue: {
    name: 'Lewat jatuh tempo',
    subject: '[{{ref}}] Lewat jatuh tempo: {{judul}}',
    body: 'Halo {{nama}},\n\nRequest "{{judul}}" telah melewati jatuh tempo ({{due}}). Status: {{status}}.\n\nMohon segera ditindaklanjuti: {{link}}',
  },
  remind: {
    name: 'Pengingat manual (tagih)',
    subject: '[{{ref}}] Pengingat dari {{aktor}}',
    body: 'Halo {{nama}},\n\n{{aktor}} mengingatkan Anda untuk menindaklanjuti "{{judul}}" ({{ref}}).\n{{alasan}}\n\nBuka: {{link}}',
  },
  commented: {
    name: 'Komentar baru',
    subject: '[{{ref}}] Komentar baru dari {{aktor}}',
    body: 'Halo {{nama}},\n\n{{aktor}} berkomentar pada "{{judul}}":\n"{{alasan}}"\n\nBalas: {{link}}',
    minPriority: 'high',
  },
  sign_request: {
    name: 'Naskah perlu ditandatangani',
    subject: '[{{ref}}] Mohon {{peran}}: {{judul}}',
    body: 'Halo {{nama}},\n\n{{aktor}} mengirim naskah "{{judul}}" ({{ref}}) yang menunggu {{peran}} Anda.\nPerihal: {{perihal}}\n\nBuka dan tanda tangani di {{link}}',
  },
  doc_signed: {
    name: 'Naskah selesai ditandatangani',
    subject: '[{{ref}}] Naskah telah ditandatangani lengkap',
    body: 'Halo {{nama}},\n\nNaskah "{{judul}}" ({{ref}}) telah ditandatangani seluruh penanda tangan. PDF final dengan QR code verifikasi tersimpan di modul Dokumen.\n\nBuka: {{link}}',
  },
  doc_rejected: {
    name: 'Naskah dikembalikan',
    subject: '[{{ref}}] Naskah dikembalikan untuk revisi',
    body: 'Halo {{nama}},\n\n{{aktor}} mengembalikan naskah "{{judul}}".\nAlasan: {{alasan}}\n\nRevisi dan kirim ulang melalui {{link}}',
  },
};

export const EVENT_TYPES = Object.keys(DEFAULT_TEMPLATES);
