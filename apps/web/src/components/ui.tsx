import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { registerBackCloser } from "@/lib/back";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on",
        ghost: "bg-transparent text-fg hover:bg-soft",
        soft: "bg-soft text-fg border border-line",
        danger: "bg-soft text-coral",
      },
      size: {
        md: "h-11 px-4 text-sm",
        sm: "h-9 px-3 text-sm",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-11 w-full rounded-2xl border border-line bg-panel px-3 text-sm outline-none placeholder:text-mute",
        props.className,
      )}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "min-h-12 w-full resize-none rounded-2xl border border-line bg-panel px-3 py-3 text-sm outline-none placeholder:text-mute",
        props.className,
      )}
    />
  );
}

export function Toggle({ checked, onCheckedChange, label }: { checked: boolean; onCheckedChange: (value: boolean) => void; label: string }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="relative h-7 w-12 rounded-full bg-line data-[state=checked]:bg-accent"
    >
      <Switch.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-panel shadow-sm transition data-[state=checked]:translate-x-6" />
    </Switch.Root>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    return registerBackCloser(() => onOpenChange(false));
  }, [open, onOpenChange]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="panel fixed left-1/2 top-1/2 z-50 max-h-[min(84dvh,720px)] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5">
          <Dialog.Title className="display text-2xl">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
