import type { HTMLAttributes, Key } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "md-outlined-select": HTMLAttributes<HTMLElement> & { key?: Key; label?: string; value?: string; disabled?: boolean };
      "md-select-option": HTMLAttributes<HTMLElement> & { key?: Key; value?: string };
      "md-outlined-button": HTMLAttributes<HTMLElement> & { disabled?: boolean };
      "md-filled-button": HTMLAttributes<HTMLElement> & { disabled?: boolean };
      "md-filter-chip": HTMLAttributes<HTMLElement> & { selected?: boolean; disabled?: boolean };
      "md-slider": HTMLAttributes<HTMLElement> & {
        value?: number;
        min?: number;
        max?: number;
        step?: number;
        disabled?: boolean;
      };
      "md-linear-progress": HTMLAttributes<HTMLElement> & { value?: number; max?: number };
    }
  }
}

export {};
