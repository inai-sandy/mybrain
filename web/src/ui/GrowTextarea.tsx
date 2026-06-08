import { useEffect, useRef } from 'react';

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Smallest height in px (default ~1 line). */
  minHeight?: number;
  /** Largest height in px before it starts scrolling (default 200). */
  maxHeight?: number;
};

/** A textarea that grows with its content (up to maxHeight, then scrolls), so you can
 *  always see everything you've typed or dictated. */
export function GrowTextarea({ value, minHeight = 40, maxHeight = 200, className = '', ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = next + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, minHeight, maxHeight]);

  return <textarea ref={ref} value={value} className={'resize-none ' + className} style={{ minHeight }} {...rest} />;
}
