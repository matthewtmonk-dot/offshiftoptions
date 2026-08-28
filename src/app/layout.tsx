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

export const metadata: Metadata = {
  title: {
    default: "LST Buddy",
    template: "%s | LST Buddy",
  },
  description: "Private PWA for conservative cash-secured-put research, tracking, and buddy accountability.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  appleWebApp: {
    capable: true,
    title: "LST Buddy",
    statusBarStyle: "black-translucent",
  },
  applicationName: "LST Buddy",
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
