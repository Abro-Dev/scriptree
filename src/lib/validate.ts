export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
// Student ID: school / year of entry + intake A–D / department / student number, e.g. BU/24C/IT/10778.
// Stored in students.matric_no. Keep in step with public.is_student_id() and the student-login function.
export const STUDENT_ID_RE = /^[A-Z]{2,5}\/[0-9]{2}[A-D]\/[A-Z]{2,5}\/[0-9]{3,6}$/;
export const isStudentId = (v: string) => STUDENT_ID_RE.test(v.trim().toUpperCase());
export const isOtp = (v: string) => /^[0-9]{6}$/.test(v.replace(/\s/g, ''));
