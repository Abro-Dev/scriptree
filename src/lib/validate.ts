export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
export const isMatric = (v: string) => /^[A-Z]{2,5}\/[0-9]{2}\/[0-9]{3,6}$/i.test(v.trim());
export const isStudentCode = (v: string) => /^ST[0-9]{4,10}$/i.test(v.trim());
export const isOtp = (v: string) => /^[0-9]{6}$/.test(v.replace(/\s/g, ''));
