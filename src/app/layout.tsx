import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Obsi-Relay",
  description: "Obsidian vault knowledge base with RAG-powered email answering",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
