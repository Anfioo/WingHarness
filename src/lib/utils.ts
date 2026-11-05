/**
 * `cn` is copied from jetbrains-cc-gui (MIT),
 * https://github.com/zhukunpenglinyutong/jetbrains-cc-gui.
 * Copyright (c) 2026 zhukunpenglinyutong.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
