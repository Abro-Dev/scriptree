export type Role = 'admin' | 'officer' | 'invigilator' | 'student';

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  email: string;
  title: string | null;
  status: 'active' | 'suspended';
  must_change_password: boolean;
}

export interface Student {
  id: string;
  matric_no: string;   // the student ID, e.g. BU/24C/IT/10778
  full_name: string;
  department: string;
  level: string;
}

/** Roles that must pass two-factor (AAL2) before the database grants them anything. */
export const MFA_ROLES: Role[] = ['admin', 'officer'];
