import { existsSync } from 'fs';
import { resolve } from 'path';

/** Identitas visual Umira — dipakai PDF, Excel, dan e-mail. */
export const BRAND = {
  teal: '#075F78',
  tealDeep: '#024558',
  tealSoft: '#E3EFF3',
  copper: '#9D521F',
  copperDeep: '#5C3203',
  copperSoft: '#F7EBE1',
  ink: '#0D2B35',
  muted: '#6A8590',
  line: '#CFDDE2',
  rowAlt: '#F4F8F9',
};

/** Path logo berwarna untuk PDF (PNG). Bisa diganti lewat env ORG_LOGO. Null bila tidak ada. */
export function logoPath(): string | null {
  const p = resolve(process.env.ORG_LOGO ?? 'assets/umira-logo.png');
  return existsSync(p) ? p : null;
}
