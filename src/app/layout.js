import { GeistSans } from "geist/font/sans";
import "./globals.css";
import "../app/api/initGoogleClients.js"; // Import to trigger global initialization

export const metadata = {
  title: "Try screenshot",
  description: "Vercel functions run headless browser url screenshot",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${GeistSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
