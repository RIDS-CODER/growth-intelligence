import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enrose AI Social",
  description: "AI Social Media Manager for Enrose Salon",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
