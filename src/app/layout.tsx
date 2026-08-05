import StyledComponentsRegistry from "@/lib/registry";

import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const title = "Hank";
const description = "Hank handles the job-hunt busywork. You call the shots.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Hank",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    siteName: "Hank",
    title,
    description,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const noFlashScript = `(function(){try{var k='hank-theme';var s=localStorage.getItem(k);var m=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=m;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <StyledComponentsRegistry>{children}</StyledComponentsRegistry>
      </body>
    </html>
  );
}
