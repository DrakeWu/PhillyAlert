import { cn } from '@/lib/utils';

export function Wordmark({ className, href = '#/' }: { className?: string; href?: string }) {
  return (
    <a href={href} className={cn('inline-flex items-center gap-2.5 font-serif text-[25px] font-semibold leading-none tracking-tight no-underline', className)}>
      <span aria-hidden className="h-[9px] w-[9px] animate-blink bg-signal" />
      PhillyAlert
    </a>
  );
}

export const REPO_URL = 'https://github.com/DrakeWu/PhillyAlert';
