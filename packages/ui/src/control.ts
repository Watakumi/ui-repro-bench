import { cn } from './cn'

export type ControlVariant = 'filled' | 'outlined'

export const controlBase =
  'flex items-center gap-[8px] rounded-[6px] border px-[11px] text-[14px] leading-[22px]'

export function controlSurface(variant: ControlVariant, focused?: boolean): string {
  if (focused) return 'border-[#1890ff] bg-white'
  return variant === 'filled'
    ? 'border-transparent bg-[#f5f5f5]'
    : 'border-[#d9d9d9] bg-white'
}

export function controlClass(
  variant: ControlVariant,
  focused?: boolean,
  className?: string,
): string {
  return cn(controlBase, controlSurface(variant, focused), className)
}
