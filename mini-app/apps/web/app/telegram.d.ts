export {};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe?: { start_param?: string; user?: { id: number; first_name?: string } };
        themeParams?: Record<string, string>;
        colorScheme?: "light" | "dark";
        ready(): void;
        expand(): void;
        close(): void;
        openTelegramLink(url: string): void;
        HapticFeedback?: { impactOccurred(style: "light" | "medium"): void; notificationOccurred(type: "error" | "success" | "warning"): void };
        BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
      };
    };
  }
}
