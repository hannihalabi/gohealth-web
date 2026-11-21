import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "GoHealth · Vårdportalen",
  description: "GoHealth vårdportal för patientuppföljning.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
