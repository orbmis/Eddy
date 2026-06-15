import type { ReactNode } from "react";

export const metadata = {
  title: "Eddy — Yield-Funded DCA",
  description: "Perpetual basket DCA funded by recurring re-ups from a yield-earning pool.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
