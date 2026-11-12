export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
// School / year of entry + intake A–D / department / student number, e.g. BU/24C/IT/10778.
// Keep in step with public.is_matric() and the student-login function.
export const MATRIC_RE = /^[A-Z]{2,5}\/[0-9]{2}[A-D]\/[A-Z]{2,5}\/[0-9]{3,6}$/;
export const isMatric = (v: string) => MATRIC_RE.test(v.trim().toUpperCase());
export const isStudentCode = (v: string) => /^ST[0-9]{4,10}$/i.test(v.trim());
export const isOtp = (v: string) => /^[0-9]{6}$/.test(v.replace(/\s/g, ''));
