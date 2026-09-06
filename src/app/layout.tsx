import type { Metadata } from "next";
import Link from "next/link";

import { OfflineShell } from "../components/offline-shell.tsx";
import { loadFeatureFlags } from "../config/features.ts";
import "./styles.css";

export const metadata: Metadata = {
  title: "旅行 Agent",
  description: "结构化、可核验的中国城市旅行规划 Agent",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <header className="site-nav">
          <Link href="/">旅行 Agent</Link>
          <nav aria-label="主导航">
            <a href="/demo">固定案例</a>
            <a href="/plan">自定义规划</a>
            <a href="/case-study">案例研究</a>
            <a href="/about">关于</a>
          </nav>
        </header>
        <OfflineShell enabled={loadFeatureFlags().offlineReadonly} />
        {children}
      </body>
    </html>
  );
}
