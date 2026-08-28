import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const appUrl = process.env.NEXT_PUBLIC_APP_URL;

export const metadata: Metadata = {
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
  title: {
    default: "Off Shift Options",
    template: "%s | Off Shift Options",
  },
  description: "Private PWA for conservative cash-secured-put research, tracking, and buddy accountability.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "OSO",
    statusBarStyle: "black-translucent",
  },
  applicationName: "Off Shift Options",
  openGraph: {
    title: "Off Shift Options",
    description: "Private PWA for conservative cash-secured-put research, tracking, and buddy accountability.",
    siteName: "Off Shift Options",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0f0d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full bg-zinc-950 antialiased`}
    >
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
