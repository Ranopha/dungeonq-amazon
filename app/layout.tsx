import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "DungeonQ — Synthetic Security Proving Ground",
  description: "A governed cyber dungeon for testing deception before reality.",
  robots: {
    index: false,
    follow: false
  },
  openGraph: {
    title: "DungeonQ — Synthetic Security Proving Ground",
    description: "Bring a synthetic scenario. Leave with replayable proof.",
    type: "website"
  },
  twitter: {
    card: "summary",
    title: "DungeonQ — Synthetic Security Proving Ground",
    description: "Bring a synthetic scenario. Leave with replayable proof."
  }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
