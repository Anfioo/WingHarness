import * as React from "react";
import { CircleHelp } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/// 放在被解释的词后面的「?」按钮：悬停/聚焦出现说明卡，点击固定，Escape 或点别处关闭。
/// 只放规则与术语解释；会丢东西、要重启这类后果写在别处。

const OPEN_DELAY = 300;
const CLOSE_DELAY = 200;

/** 焦点是不是键盘带来的（Tab / 方向键）；浏览器不认 :focus-visible 时按键盘处理。 */
function isKeyboardFocus(element: HTMLElement) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function useHoverCard() {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);

  const clear = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };

  React.useEffect(() => clear, []);

  const schedule = (next: boolean, delay: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };

  return {
    open: open || pinned,
    pinned,
    onPointerEnter: () => {
      if (!pinned) schedule(true, OPEN_DELAY);
    },
    onPointerLeave: () => {
      if (!pinned) schedule(false, CLOSE_DELAY);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (!isKeyboardFocus(event.currentTarget)) return;
      clear();
      setOpen(true);
    },
    onBlur: () => {
      if (!pinned) {
        clear();
        setOpen(false);
      }
    },
    onClick: () => {
      clear();
      setPinned((value) => !value);
      setOpen(true);
    },
    onOpenChange: (next: boolean) => {
      if (!next) {
        clear();
        setPinned(false);
        setOpen(false);
      }
    },
  };
}

export interface HelpTipProps {
  /** 卡片标题，同时是「?」按钮的无障碍名字。写成问题或名词。 */
  title: string;
  /** 正文。 */
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}

export function HelpTip({ title, children, side, align, className }: HelpTipProps) {
  const id = React.useId();
  const descId = `${id}-desc`;
  const hover = useHoverCard();

  return (
    <Popover open={hover.open} onOpenChange={hover.onOpenChange}>
      {/* 卡片只在打开时挂载；屏幕阅读器读这份一直在的副本 */}
      <span id={descId} className="sr-only">
        {children}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={title}
          aria-describedby={descId}
          onPointerEnter={hover.onPointerEnter}
          onPointerLeave={hover.onPointerLeave}
          onFocus={hover.onFocus}
          onBlur={hover.onBlur}
          onClick={(event) => {
            event.preventDefault();
            hover.onClick();
          }}
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground -my-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle transition-colors data-[state=open]:bg-accent data-[state=open]:text-foreground",
            className
          )}
        >
          <CircleHelp className="size-3.5" strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={id}
        role="tooltip"
        side={side}
        align={align}
        sideOffset={6}
        alignOffset={-8}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        className="z-[120] w-max max-w-[320px] p-3 text-xs leading-relaxed"
      >
        <span className="mb-0.5 block font-semibold">{title}</span>
        {children}
      </PopoverContent>
    </Popover>
  );
}
