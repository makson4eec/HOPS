import { z } from "zod";

// The customer chooses the length and characters; only an empty value is invalid.
export const passwordSchema = z.string().min(1, "Введите пароль.");
