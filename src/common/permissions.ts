/** Katalog permission (FR-ACC-04). Dipakai oleh guard & seed. */
export const PERMISSIONS = {
  // Akun & organisasi
  USER_MANAGE: { module: 'account', description: 'Kelola pengguna (create/update/disable/reset/delete)' },
  ROLE_MANAGE: { module: 'account', description: 'Kelola role & matriks permission' },
  DEPT_MANAGE: { module: 'account', description: 'Kelola struktur organisasi' },
  DELEGATION_CREATE: { module: 'account', description: 'Membuat delegasi approval' },
  DELEGATION_MANAGE: { module: 'account', description: 'Melihat & mengelola seluruh delegasi' },
  // Workflow
  REQUEST_CREATE: { module: 'workflow', description: 'Membuat & mengubah request milik sendiri' },
  REQUEST_VIEW_DEPT: { module: 'workflow', description: 'Melihat request di departemen sendiri' },
  REQUEST_VIEW_ALL: { module: 'workflow', description: 'Melihat seluruh request (read-only)' },
  REQUEST_MANAGE: { module: 'workflow', description: 'Mengubah status/assignee request orang lain' },
  REQUEST_TYPE_MANAGE: { module: 'workflow', description: 'Kelola tipe request & custom field' },
  // Dokumen
  DOC_UPLOAD: { module: 'document', description: 'Unggah dokumen & buat folder' },
  DOC_VIEW_ALL: { module: 'document', description: 'Melihat seluruh dokumen (read-only)' },
  DOC_MANAGE: { module: 'document', description: 'Kelola dokumen unit (hapus, pindah, share)' },
  DOC_SHARE: { module: 'document', description: 'Membagikan dokumen' },
  // Approval
  APPROVAL_DECIDE: { module: 'approval', description: 'Approve / reject / delegate' },
  APPROVAL_FLOW_MANAGE: { module: 'approval', description: 'Kelola alur approval' },
  // Naskah dinas (dibuat di aplikasi + tanda tangan QR)
  EDOC_CREATE: { module: 'edoc', description: 'Membuat naskah dinas di aplikasi' },
  EDOC_VIEW_ALL: { module: 'edoc', description: 'Melihat seluruh naskah dinas (read-only)' },
  EDOC_TEMPLATE_MANAGE: { module: 'edoc', description: 'Kelola template & format nomor naskah' },
  // Ekspor, notifikasi, audit
  EXPORT: { module: 'export', description: 'Ekspor laporan Excel/PDF' },
  NOTIF_MANAGE: { module: 'notification', description: 'Kelola template & log notifikasi' },
  AUDIT_VIEW: { module: 'audit', description: 'Melihat & mengekspor audit trail' },
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;

export const ROLE_NAMES = {
  SUPER_ADMIN: 'Super Admin',
  DEPT_ADMIN: 'Admin Departemen',
  APPROVER: 'Approver',
  STAFF: 'Staff',
  AUDITOR: 'Auditor',
} as const;

/** Matriks RBAC default — dapat diubah Super Admin melalui UI. */
export const DEFAULT_ROLE_MATRIX: Record<string, PermissionCode[]> = {
  [ROLE_NAMES.SUPER_ADMIN]: Object.keys(PERMISSIONS) as PermissionCode[],
  [ROLE_NAMES.DEPT_ADMIN]: [
    'DEPT_MANAGE', 'DELEGATION_CREATE', 'REQUEST_CREATE', 'REQUEST_VIEW_DEPT', 'REQUEST_MANAGE',
    'DOC_UPLOAD', 'DOC_MANAGE', 'DOC_SHARE', 'APPROVAL_DECIDE', 'APPROVAL_FLOW_MANAGE', 'EXPORT', 'EDOC_CREATE',
  ],
  [ROLE_NAMES.APPROVER]: [
    'DELEGATION_CREATE', 'REQUEST_CREATE', 'REQUEST_VIEW_DEPT', 'DOC_UPLOAD', 'DOC_SHARE', 'APPROVAL_DECIDE', 'EXPORT', 'EDOC_CREATE',
  ],
  [ROLE_NAMES.STAFF]: ['REQUEST_CREATE', 'DOC_UPLOAD', 'DOC_SHARE', 'EDOC_CREATE'],
  [ROLE_NAMES.AUDITOR]: ['REQUEST_VIEW_ALL', 'DOC_VIEW_ALL', 'AUDIT_VIEW', 'EXPORT', 'EDOC_VIEW_ALL'],
};

export const PRIORITY_RANK: Record<string, number> = { low: 1, med: 2, high: 3, crit: 4 };

/** Role jenjang approval memakai matriks Approver. */
export const APPROVER_LIKE_ROLES = ['Team Lead', 'Manajer', 'Direktur'];
