// Adapted from shadcn/ui Button (MIT). Source and license: ./UPSTREAM.md.
import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const buttonVariants=cva('pa-button',{variants:{variant:{default:'pa-button-primary',destructive:'pa-button-danger',outline:'pa-button-secondary',secondary:'pa-button-secondary',ghost:'pa-button-ghost',link:'pa-button-link'},size:{default:'pa-button-md',sm:'pa-button-sm',lg:'pa-button-lg',icon:'pa-button-icon'}},defaultVariants:{variant:'default',size:'default'}});
export function Button({className,variant='default',size='default',asChild=false,...props}:ComponentProps<'button'>&VariantProps<typeof buttonVariants>&{asChild?:boolean}) {
  const Comp=asChild?Slot:'button';return <Comp data-slot="button" data-variant={variant} data-size={size} className={twMerge(clsx(buttonVariants({variant,size,className})))} {...props}/>;
}
