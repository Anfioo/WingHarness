import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const PreviewMenuTarget = createContext<HTMLElement | null>(null);

export function PreviewMenu({ children }: { children: ReactNode }) {
  const target = useContext(PreviewMenuTarget);
  return target ? createPortal(children, target) : null;
}

export default function PreviewToolbar({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const target = useContext(PreviewMenuTarget);
  if (!target) return null;
  return createPortal(
    <div
      className={className}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    target,
  );
}
