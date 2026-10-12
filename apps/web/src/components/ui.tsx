import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { registerBackCloser } from "@/lib/back";
import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "btn inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap",
  {
    variants: {
      variant: {
        primary: "btn-primary",
        ghost: "btn-ghost",
        soft: "btn-soft",
        danger: "btn-danger",
      },
      size: {
        md: "h-12 px-6 text-[15px]",
        sm: "h-10 px-4 text-sm",
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
        "input",
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
        "input resize-none",
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
      className="toggle relative h-7 w-12 shrink-0 rounded-full bg-line data-[state=checked]:bg-accent"
    >
      <Switch.Thumb className="toggle-thumb block h-5 w-5 translate-x-1 rounded-full bg-white data-[state=checked]:translate-x-6" />
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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="panel !rounded-[20px] !shadow-[var(--ma-shadow-lg)] fixed left-1/2 top-1/2 z-50 max-h-[min(84dvh,720px)] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5">
          <Dialog.Title className="display text-2xl">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function EmptyState({ text, icon: Icon = Inbox }: { text: string; icon?: LucideIcon }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon size={24} strokeWidth={1.75} /></span>
      <p>{text}</p>
    </div>
  );
}
