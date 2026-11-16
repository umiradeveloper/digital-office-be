import { PermissionCode } from './permissions';

export interface AuthUser {
  id: bigint;
  email: string;
  fullName: string;
  departmentId: bigint | null;
  isSuperAdmin: boolean;
  roles: string[];
  roleIds: bigint[];
  permissions: PermissionCode[];
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; perPage: number; total: number; totalPages: number };
}
